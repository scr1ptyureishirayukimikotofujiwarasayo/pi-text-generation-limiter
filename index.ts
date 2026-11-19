/**
 * pi-text-generation-limiter
 *
 * A simple text generation limiter for Pi Code that helps control output length
 * without aggressive system prompts or token limits.
 *
 * One word limit (`/textlimit <n>`) applies to all three surfaces:
 * 1. Chat text   - assistant text blocks, truncated when finalized
 * 2. Reasoning   - assistant thinking blocks, truncated when finalized and while streaming
 * 3. Tool output - text returned by tool calls, truncated before it is sent back to the model
 *
 * Reasoning limiting caps only the stored/displayed thinking text, never reasoning tokens.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** State entry key for persistence */
const STATE_ENTRY = "text-generation-limiter";

/** Status key for UI display */
const STATUS_KEY = "textlimiter";

/** Default word limit */
const DEFAULT_WORD_LIMIT = 100;

/** Default number of most recent tool results kept in full context */
const DEFAULT_KEEP_RECENT_TOOLS = 12;

/** Bounds for the recent tool result count */
const MIN_KEEP_RECENT_TOOLS = 1;
const MAX_KEEP_RECENT_TOOLS = 100;

/** Minimum allowed word limit */
const MIN_WORD_LIMIT = 1;

/** Maximum allowed word limit */
const MAX_WORD_LIMIT = 500;

/** Marker for truncated text */
const TRUNCATION_MARKER = " ...(text truncated by limiter)";

/** Type for the limiter state */
interface LimiterState {
  enabled: boolean;
  wordLimit: number;
  /** Keep this many most recent tool results in full; older ones are replaced with a placeholder. */
  keepRecentTools: number;
}

/** Clamp and round a word limit into the allowed range */
function clampLimit(limit: number): number {
  return Math.min(MAX_WORD_LIMIT, Math.max(MIN_WORD_LIMIT, Math.round(limit)));
}

/** Count whitespace-separated words in text */
function countWords(text: string): number {
  const words = text.trim().split(/\s+/);
  return words.length === 1 && words[0] === "" ? 0 : words.length;
}

/** Truncate text to approximately the specified word limit */
function truncateText(text: string, wordLimit: number, marker: (omitted: number) => string = () => TRUNCATION_MARKER): string {
  const total = countWords(text);
  if (total <= wordLimit) {
    return text;
  }
  const words = text.trim().split(/\s+/);
  return words.slice(0, wordLimit).join(" ") + marker(total - wordLimit);
}

/**
 * Cap the blocks of one type (`text` or `thinking`) to a shared word budget.
 * Returns the new block list and whether anything changed.
 */
function capBlocks(
  blocks: any[],
  type: "text" | "thinking",
  budget: number,
  marker?: (omitted: number) => string,
): { blocks: any[]; modified: boolean } {
  let remaining = budget;
  let modified = false;
  const out = blocks.flatMap((block: any) => {
    if (!block || typeof block !== "object" || block.type !== type || typeof block[type] !== "string") {
      return [block];
    }
    if (remaining <= 0) {
      modified = true;
      return [];
    }
    const wc = countWords(block[type]);
    if (wc > remaining) {
      modified = true;
      const t = truncateText(block[type], remaining, marker);
      remaining = 0;
      return [{ ...block, [type]: t }];
    }
    remaining -= wc;
    return [block];
  });
  return { blocks: out, modified };
}

export default function textGenerationLimiter(pi: ExtensionAPI) {
  const state: LimiterState = {
    enabled: false,
    wordLimit: DEFAULT_WORD_LIMIT,
    keepRecentTools: DEFAULT_KEEP_RECENT_TOOLS,
  };

  /** Update UI status display */
  const setStatus = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(STATUS_KEY, state.enabled ? `≤${state.wordLimit}w·last${state.keepRecentTools}t` : undefined);
  };

  /** Save state to session */
  const save = (): void => {
    pi.appendEntry(STATE_ENTRY, {
      enabled: state.enabled,
      wordLimit: state.wordLimit,
      keepRecentTools: state.keepRecentTools,
    });
  };

  /** Restore state from session */
  const restore = (ctx: ExtensionContext): void => {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
      const data = entry.data as Partial<LimiterState> | undefined;
      if (!data) continue;
      if (typeof data.enabled === "boolean") state.enabled = data.enabled;
      if (typeof data.wordLimit === "number") state.wordLimit = clampLimit(data.wordLimit);
      if (typeof data.keepRecentTools === "number") {
        state.keepRecentTools = Math.min(MAX_KEEP_RECENT_TOOLS, Math.max(MIN_KEEP_RECENT_TOOLS, Math.round(data.keepRecentTools)));
      }
    }
    setStatus(ctx);
  };

  /** Notify user about current settings */
  const notifySettings = (ctx: ExtensionContext): void => {
    const status = state.enabled ? `ON: max ${state.wordLimit} words, keep last ${state.keepRecentTools} tool results` : "OFF";
    ctx.ui.notify(
      `Text generation limiter ${status} (applies to chat, reasoning and tool output)`,
      "info",
    );
  };

  /** Commit state changes */
  const commit = (ctx: ExtensionContext): void => {
    save();
    setStatus(ctx);
    notifySettings(ctx);
  };

  /** Set limiter enabled/disabled */
  const setLimiterEnabled = (ctx: ExtensionContext, enabled: boolean): void => {
    if (state.enabled === enabled) {
      ctx.ui.notify(enabled ? "Text limiter already ON" : "Text limiter already OFF", "info");
      return;
    }
    state.enabled = enabled;
    commit(ctx);
  };

  /** Set word limit */
  const setWordLimit = (ctx: ExtensionContext, limit: number): void => {
    const clamped = clampLimit(limit);
    if (state.wordLimit === clamped) {
      ctx.ui.notify(`Word limit already set to ${clamped}`, "info");
      return;
    }
    state.wordLimit = clamped;
    commit(ctx);
  };

  // Restore state on session start
  pi.on("session_start", async (_event, ctx) => {
    restore(ctx);
  });

  // Restore state on session tree changes
  pi.on("session_tree", async (_event, ctx) => {
    restore(ctx);
  });

  // Toggle shortcut
  pi.registerShortcut("ctrl+alt+l", {
    description: "Toggle text generation limiter",
    handler: async (ctx) => setLimiterEnabled(ctx, !state.enabled),
  });

  // Truncate finalized assistant messages (chat text + reasoning).
  // `message_end` can return `{ message }` to replace the finalized message
  // (the replacement must keep the same role).
  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return;
    if (!state.enabled) return;

    let content: any = event.message.content;
    let modified = false;

    if (typeof content === "string") {
      if (countWords(content) > state.wordLimit) {
        content = truncateText(content, state.wordLimit);
        modified = true;
      }
    } else if (Array.isArray(content)) {
      // Thinking and text each get the full budget; they are separate surfaces.
      const think = capBlocks(content, "thinking", state.wordLimit);
      const text = capBlocks(think.blocks, "text", state.wordLimit);
      content = text.blocks;
      modified = think.modified || text.modified;
    }

    if (modified) {
      return { message: { ...event.message, content } };
    }
  });

  // Cap OLDER tool results before each LLM call. The most recent batch of tool results is
  // left intact so the model can act on its current data without re-running tools.
  // Works on a copy (the `context` event is non-destructive), so the stored session is unchanged.
  // Image blocks pass through. Error results are left intact so failures stay readable.
  pi.on("context", async (event) => {
    if (!state.enabled) return;
    const messages: any[] = event.messages;

    // The latest turn starts at the last assistant message. Tool results after it are the
    // model's current data and stay intact; everything before it is older and gets capped.
    let latestStart = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant") {
        latestStart = i;
        break;
      }
    }

    // Index of the oldest tool result still kept in full. Tool results before it are replaced
    // with a placeholder (the tool call stays in the transcript, so no call is left unanswered).
    const toolIdx: number[] = [];
    messages.forEach((m: any, i: number) => { if (m?.role === "toolResult") toolIdx.push(i); });
    const keepFrom = toolIdx.length > state.keepRecentTools ? toolIdx[toolIdx.length - state.keepRecentTools] : 0;

    let modified = false;
    const out = messages.map((msg: any, i: number) => {
      if (msg?.role === "toolResult" && i < keepFrom && !msg.isError && Array.isArray(msg.content)) {
        const words = msg.content.reduce((n: number, b: any) =>
          n + (b?.type === "text" && typeof b.text === "string" ? countWords(b.text) : 0), 0);
        modified = true;
        return {
          ...msg,
          content: [{ type: "text", text: `[${msg.toolName} output omitted to save context (${words} words). Re-run the tool if you need it.]` }],
        };
      }
      if (i >= latestStart) return msg;
      if (msg?.role !== "toolResult" || msg.isError || !Array.isArray(msg.content)) return msg;

      // Tell the model the output is partial and how much was cut, so it doesn't loop re-running the tool.
      const toolMarker = (omitted: number) =>
        ` ...[${omitted} more words omitted from this older tool output to save context; re-run the tool if you need it]`;
      const { blocks, modified: changed } = capBlocks(msg.content, "text", state.wordLimit, toolMarker);
      if (!changed) return msg;
      modified = true;
      return { ...msg, content: blocks };
    });

    if (modified) {
      return { messages: out };
    }
  });

  // Cap assistant text and reasoning while they stream (display only; stored message is unchanged).
  pi.registerMarkdownTransformer(
    (markdown, { messageType, isStreaming }) => {
      if (messageType !== "assistant" && messageType !== "assistant-thinking") return markdown;
      if (!state.enabled) return markdown;
      const limit = state.wordLimit;
      if (countWords(markdown) <= limit) return markdown;
      const words = markdown.trim().split(/\s+/);
      return words.slice(0, limit).join(" ") + (isStreaming ? "" : TRUNCATION_MARKER);
    },
    { messageTypes: ["assistant", "assistant-thinking"] },
  );

  // Command: /textlimit <n> | on | off | toggle | status
  pi.registerCommand("textlimit", {
    description: "Control the text generation limiter (chat, reasoning and tool output)",
    getArgumentCompletions: (prefix: string) => {
      const candidates = ["status", "toggle", "on", "off", "context", "context 10", "context 12", "context 15", "20", "50", "100", "200", "300", "400", "500"];
      const typed = prefix.trim().toLowerCase();
      // Numeric input is free-form: never offer suggestions for it, so Enter submits exactly what was typed
      if (/^\d/.test(typed) || /^context\s+\d/.test(typed)) return null;
      const matches = candidates
        .filter((value) => value.startsWith(typed))
        .map((value) => ({ value, label: value }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      const usage = "Usage: /textlimit <1-500> | on | off | toggle | status | context <1-100>";

      if (arg === "" || arg === "status") {
        notifySettings(ctx);
        return;
      }

      // Context trimming: /textlimit context <N>  (keep the N most recent tool results in full)
      if (arg === "context" || arg.startsWith("context ")) {
        const sub = arg.slice("context".length).trim();
        const value = Number(sub);
        if (!Number.isFinite(value) || value < MIN_KEEP_RECENT_TOOLS) {
          ctx.ui.notify("Usage: /textlimit context <1-100>  (keep this many most recent tool results in full)", "warning");
          return;
        }
        const clamped = Math.min(MAX_KEEP_RECENT_TOOLS, Math.max(MIN_KEEP_RECENT_TOOLS, Math.round(value)));
        state.keepRecentTools = clamped;
        setLimiterEnabled(ctx, true);
        save();
        setStatus(ctx);
        ctx.ui.notify(`Context trimming: keeping the last ${clamped} tool results in full`, "info");
        return;
      }

      if (arg === "toggle") {
        setLimiterEnabled(ctx, !state.enabled);
      } else if (arg === "off" || arg === "disable") {
        setLimiterEnabled(ctx, false);
      } else if (arg === "on" || arg === "enable") {
        setLimiterEnabled(ctx, true);
      } else {
        const value = Number(arg);
        if (!Number.isFinite(value) || value < MIN_WORD_LIMIT) {
          ctx.ui.notify(usage, "warning");
          return;
        }
        setWordLimit(ctx, value);
        setLimiterEnabled(ctx, true); // Setting a limit turns the limiter on
      }
    },
  });
}
