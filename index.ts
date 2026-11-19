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
 *
 * Silent compaction (`/silentcompaction <tokens>`) replaces the old tool-output trimmer: when the
 * context grows past the threshold, the conversation is compacted in the background without
 * interrupting the running task.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** State entry key for persistence */
const STATE_ENTRY = "text-generation-limiter";

/** Status key for UI display */
const STATUS_KEY = "textlimiter";

/** Default word limit */
const DEFAULT_WORD_LIMIT = 100;

/** Bounds for the silent compaction token threshold (0 = disabled) */
const MIN_COMPACT_TOKENS = 1000;
const MAX_COMPACT_TOKENS = 10_000_000;

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
  /** Silently compact when context tokens exceed this; 0 = silent compaction off. */
  compactTokens: number;
}

/** Clamp and round a word limit into the allowed range */
function clampLimit(limit: number): number {
  return Math.min(MAX_WORD_LIMIT, Math.max(MIN_WORD_LIMIT, Math.round(limit)));
}

/** Clamp a silent compaction token threshold into the allowed range */
function clampCompactTokens(tokens: number): number {
  return Math.min(MAX_COMPACT_TOKENS, Math.max(MIN_COMPACT_TOKENS, Math.round(tokens)));
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
    compactTokens: 0,
  };

  /** True while a silent compaction is running, so we don't queue duplicates. */
  let compacting = false;

  /** Update UI status display */
  const setStatus = (ctx: ExtensionContext): void => {
    const parts: string[] = [];
    if (state.enabled) parts.push(`≤${state.wordLimit}w`);
    if (state.compactTokens > 0) parts.push(`compact@${state.compactTokens}t`);
    ctx.ui.setStatus(STATUS_KEY, parts.length > 0 ? parts.join("·") : undefined);
  };

  /** Save state to session */
  const save = (): void => {
    pi.appendEntry(STATE_ENTRY, {
      enabled: state.enabled,
      wordLimit: state.wordLimit,
      compactTokens: state.compactTokens,
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
      if (typeof data.compactTokens === "number") {
        state.compactTokens = data.compactTokens > 0 ? clampCompactTokens(data.compactTokens) : 0;
      }
    }
    setStatus(ctx);
  };

  /** Notify user about current settings */
  const notifySettings = (ctx: ExtensionContext): void => {
    const limiter = state.enabled ? `ON: max ${state.wordLimit} words` : "OFF";
    const compact = state.compactTokens > 0 ? `ON at ${state.compactTokens} tokens` : "OFF";
    ctx.ui.notify(`Text generation limiter ${limiter} (chat, reasoning, tool output) · Silent compaction ${compact}`, "info");
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

  // Silent compaction: after each turn, if context exceeds the threshold, compact in the
  // background. ctx.compact() is non-blocking, and we only surface a message on failure, so the
  // running task is not interrupted.
  const maybeCompact = (ctx: ExtensionContext): void => {
    if (state.compactTokens <= 0 || compacting) return;
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens == null || usage.tokens < state.compactTokens) return;
    compacting = true;
    ctx.compact({
      customInstructions: "Summarize the conversation so far concisely, preserving the current task, decisions, open questions and relevant file paths.",
      onComplete: () => { compacting = false; },
      onError: (error) => {
        compacting = false;
        ctx.ui.notify(`Silent compaction failed: ${error.message}`, "error");
      },
    });
  };

  pi.on("turn_end", async (_event, ctx) => {
    maybeCompact(ctx);
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

  // Command: /silentcompaction <tokens> | off | status
  pi.registerCommand("silentcompaction", {
    description: "Silently compact the conversation in the background once context exceeds <tokens>",
    getArgumentCompletions: (prefix: string) => {
      const typed = prefix.trim().toLowerCase();
      if (/^\d/.test(typed)) return null;
      const matches = ["off", "status", "50000", "100000", "150000"]
        .filter((value) => value.startsWith(typed))
        .map((value) => ({ value, label: value }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      const usage = `Usage: /silentcompaction <${MIN_COMPACT_TOKENS}-${MAX_COMPACT_TOKENS}> | off | status`;

      if (arg === "" || arg === "status") {
        const msg = state.compactTokens > 0
          ? `Silent compaction ON: compacts in the background above ${state.compactTokens} context tokens`
          : "Silent compaction OFF";
        ctx.ui.notify(msg, "info");
        return;
      }

      if (arg === "off" || arg === "disable") {
        state.compactTokens = 0;
        save();
        setStatus(ctx);
        ctx.ui.notify("Silent compaction OFF", "info");
        return;
      }

      const value = Number(arg);
      if (!Number.isFinite(value) || value < MIN_COMPACT_TOKENS) {
        ctx.ui.notify(usage, "warning");
        return;
      }
      state.compactTokens = clampCompactTokens(value);
      save();
      setStatus(ctx);
      ctx.ui.notify(`Silent compaction ON: compacts in the background above ${state.compactTokens} context tokens`, "info");
    },
  });

  // Command: /textlimit <n> | on | off | toggle | status
  pi.registerCommand("textlimit", {
    description: "Control the text generation limiter (chat, reasoning and tool output)",
    getArgumentCompletions: (prefix: string) => {
      const candidates = ["status", "toggle", "on", "off", "20", "50", "100", "200", "300", "400", "500"];
      const typed = prefix.trim().toLowerCase();
      // Numeric input is free-form: never offer suggestions for it, so Enter submits exactly what was typed
      if (/^\d/.test(typed)) return null;
      const matches = candidates
        .filter((value) => value.startsWith(typed))
        .map((value) => ({ value, label: value }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      const usage = "Usage: /textlimit <1-500> | on | off | toggle | status";

      if (arg === "" || arg === "status") {
        notifySettings(ctx);
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
