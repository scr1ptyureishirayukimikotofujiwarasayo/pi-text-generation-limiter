/**
 * pi-text-generation-limiter
 *
 * A simple text generation limiter for Pi Code that helps control output length
 * without aggressive system prompts or token limits.
 *
 * Features:
 * 1. Word count limiting - Sets a soft word limit for responses
 * 2. Text truncation - Truncates overly long responses with a marker
 * 3. Simple notification system - Informs users about text limits
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** State entry key for persistence */
const STATE_ENTRY = "text-generation-limiter";

/** Status key for UI display */
const STATUS_KEY = "textlimiter";

/** Default word limit for responses */
const DEFAULT_WORD_LIMIT = 100;

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
  /** Separate word budget for model reasoning (thinking) blocks. Does not cap reasoning tokens. */
  reasoningEnabled: boolean;
  reasoningWordLimit: number;
}

/** Count whitespace-separated words in text */
function countWords(text: string): number {
  const words = text.trim().split(/\s+/);
  return words.length === 1 && words[0] === "" ? 0 : words.length;
}

/** Truncate text to approximately the specified word limit */
function truncateText(text: string, wordLimit: number): string {
  // If text is already within limit, return as is
  if (countWords(text) <= wordLimit) {
    return text;
  }
  
  // Split into words and take only what we need
  const words = text.trim().split(/\s+/);
  const truncatedWords = words.slice(0, wordLimit);
  return truncatedWords.join(" ") + TRUNCATION_MARKER;
}

export default function textGenerationLimiter(pi: ExtensionAPI) {
  const state: LimiterState = {
    enabled: false,
    wordLimit: DEFAULT_WORD_LIMIT,
    reasoningEnabled: false,
    reasoningWordLimit: DEFAULT_WORD_LIMIT,
  };

  /** Update UI status display */
  const setStatus = (ctx: ExtensionContext): void => {
    const parts: string[] = [];
    if (state.enabled) parts.push(`≤${state.wordLimit}w`);
    if (state.reasoningEnabled) parts.push(`think≤${state.reasoningWordLimit}w`);
    ctx.ui.setStatus(STATUS_KEY, parts.length > 0 ? parts.join(" ") : undefined);
  };

  /** Save state to session */
  const save = (): void => {
    pi.appendEntry(STATE_ENTRY, {
      enabled: state.enabled,
      wordLimit: state.wordLimit,
      reasoningEnabled: state.reasoningEnabled,
      reasoningWordLimit: state.reasoningWordLimit,
    });
  };

  /** Restore state from session */
  const restore = (ctx: ExtensionContext): void => {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
      const data = entry.data as Partial<LimiterState> | undefined;
      if (!data) continue;
      if (typeof data.enabled === "boolean") state.enabled = data.enabled;
      if (typeof data.wordLimit === "number") {
        state.wordLimit = Math.min(MAX_WORD_LIMIT, Math.max(MIN_WORD_LIMIT, Math.round(data.wordLimit)));
      }
      if (typeof data.reasoningEnabled === "boolean") state.reasoningEnabled = data.reasoningEnabled;
      if (typeof data.reasoningWordLimit === "number") {
        state.reasoningWordLimit = Math.min(MAX_WORD_LIMIT, Math.max(MIN_WORD_LIMIT, Math.round(data.reasoningWordLimit)));
      }
    }
    setStatus(ctx);
  };

  /** Notify user about current settings */
  const notifySettings = (ctx: ExtensionContext): void => {
    const chat = state.enabled ? `chat ON: max ${state.wordLimit} words` : "chat OFF";
    const reasoning = state.reasoningEnabled
      ? `reasoning ON: max ${state.reasoningWordLimit} words`
      : "reasoning OFF";
    ctx.ui.notify(`Text generation limiter — ${chat}, ${reasoning}`, "info");
  };

  /** Commit state changes */
  const commit = (ctx: ExtensionContext): void => {
    save();
    setStatus(ctx);
    notifySettings(ctx);
  };

  /** Toggle limiter on/off */
  const toggleLimiter = (ctx: ExtensionContext): void => {
    state.enabled = !state.enabled;
    commit(ctx);
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

  /** Set reasoning enabled/disabled */
  const setReasoningEnabled = (ctx: ExtensionContext, enabled: boolean): void => {
    if (state.reasoningEnabled === enabled) {
      ctx.ui.notify(enabled ? "Reasoning limiter already ON" : "Reasoning limiter already OFF", "info");
      return;
    }
    state.reasoningEnabled = enabled;
    commit(ctx);
  };

  /** Set reasoning word limit */
  const setReasoningWordLimit = (ctx: ExtensionContext, limit: number): void => {
    const clamped = Math.min(MAX_WORD_LIMIT, Math.max(MIN_WORD_LIMIT, Math.round(limit)));
    if (state.reasoningWordLimit === clamped) {
      ctx.ui.notify(`Reasoning word limit already set to ${clamped}`, "info");
      return;
    }
    state.reasoningWordLimit = clamped;
    commit(ctx);
  };

  /** Set word limit */
  const setWordLimit = (ctx: ExtensionContext, limit: number): void => {
    const clampedLimit = Math.min(MAX_WORD_LIMIT, Math.max(MIN_WORD_LIMIT, Math.round(limit)));
    if (state.wordLimit === clampedLimit) {
      ctx.ui.notify(`Word limit already set to ${clampedLimit}`, "info");
      return;
    }
    state.wordLimit = clampedLimit;
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

  // Register shortcut to toggle limiter
  pi.registerShortcut("ctrl+alt+l", {
    description: "Toggle text generation limiter",
    handler: async (ctx) => toggleLimiter(ctx),
  });

  // Register shortcut to toggle the reasoning limiter
  pi.registerShortcut("ctrl+alt+r", {
    description: "Toggle reasoning text limiter",
    handler: async (ctx) => setReasoningEnabled(ctx, !state.reasoningEnabled),
  });

  // Truncate finalized assistant messages to apply the word limits.
  // `message_end` can return `{ message }` to replace the finalized message
  // (the replacement must keep the same role).
  // Reasoning (thinking) blocks get their own word budget; text blocks get the chat budget.
  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return;
    if (!state.enabled && !state.reasoningEnabled) return;

    let content: any = event.message.content;
    let modified = false;

    if (typeof content === "string") {
      // String content has no thinking blocks; chat limit only
      if (state.enabled && countWords(content) > state.wordLimit) {
        content = truncateText(content, state.wordLimit);
        modified = true;
      }
    } else if (Array.isArray(content)) {
      // Reasoning budget caps the stored thinking text only, never reasoning tokens.
      let remainingThink = state.reasoningWordLimit;
      // Chat budget applies across all text blocks
      let remainingText = state.wordLimit;

      content = content.flatMap((block: any) => {
        if (block && typeof block === "object" && block.type === "thinking" && typeof block.thinking === "string") {
          if (!state.reasoningEnabled) return [block];
          if (remainingThink <= 0) { modified = true; return []; }
          const wc = countWords(block.thinking);
          if (wc > remainingThink) {
            modified = true;
            const t = truncateText(block.thinking, remainingThink);
            remainingThink = 0;
            return [{ ...block, thinking: t }];
          }
          remainingThink -= wc;
          return [block];
        }
        if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
          if (!state.enabled) return [block];
          if (remainingText <= 0) { modified = true; return []; }
          const wc = countWords(block.text);
          if (wc > remainingText) {
            modified = true;
            const t = truncateText(block.text, remainingText);
            remainingText = 0;
            return [{ ...block, text: t }];
          }
          remainingText -= wc;
        }
        return [block];
      });
    }

    if (modified) {
      return { message: { ...event.message, content } };
    }
  });

  // Cap assistant text and reasoning while they stream (display only; stored message is unchanged).
  // An extension has one transformer, so this handles both the chat and reasoning surfaces.
  pi.registerMarkdownTransformer(
    (markdown, { messageType, isStreaming }) => {
      const limit =
        messageType === "assistant" && state.enabled ? state.wordLimit :
        messageType === "assistant-thinking" && state.reasoningEnabled ? state.reasoningWordLimit :
        undefined;
      if (limit === undefined) return markdown;
      if (countWords(markdown) <= limit) return markdown;
      const words = markdown.trim().split(/\s+/);
      return words.slice(0, limit).join(" ") + (isStreaming ? "" : TRUNCATION_MARKER);
    },
    { messageTypes: ["assistant", "assistant-thinking"] },
  );

  // Register command to control the limiter
  pi.registerCommand("textlimit", {
    description: "Control the text generation limiter",
    getArgumentCompletions: (prefix: string) => {
      const candidates = ["status", "toggle", "on", "off", "think", "think on", "think off", "think toggle", "think 20", "think 50", "think 100", "think 200", "think 300", "think 400", "think 500", "20", "50", "100", "200", "300", "400", "500"];
      const typed = prefix.trim().toLowerCase();
      // Numeric input is free-form: never offer suggestions for it, so Enter submits exactly what was typed
      if (/^\d/.test(typed) || /^think\s+\d/.test(typed)) return null;
      const matches = candidates
        .filter((value) => value.startsWith(typed))
        .map((value) => ({ value, label: value }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      const usage = "Usage: /textlimit <1-500> | on | off | toggle | status | think <1-500> | think on | think off | think toggle";

      if (arg === "" || arg === "status") {
        notifySettings(ctx);
        return;
      }

      // Reasoning limiter: /textlimit think [on|off|toggle|<1-500>]
      if (arg === "think" || arg.startsWith("think ")) {
        const sub = arg.slice("think".length).trim();
        if (sub === "" || sub === "toggle") {
          setReasoningEnabled(ctx, !state.reasoningEnabled);
        } else if (sub === "off" || sub === "disable") {
          setReasoningEnabled(ctx, false);
        } else if (sub === "on" || sub === "enable") {
          setReasoningEnabled(ctx, true);
        } else {
          const value = Number(sub);
          if (!Number.isFinite(value) || value < MIN_WORD_LIMIT) {
            ctx.ui.notify(usage, "warning");
            return;
          }
          setReasoningWordLimit(ctx, value);
          setReasoningEnabled(ctx, true);
        }
        return;
      }

      if (arg === "toggle") {
        toggleLimiter(ctx);
        return;
      }

      if (arg === "off" || arg === "disable") {
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
        setLimiterEnabled(ctx, true); // Enable when setting a limit
      }
    },
  });
}