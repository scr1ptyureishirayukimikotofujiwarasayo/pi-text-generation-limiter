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
  };

  /** Update UI status display */
  const setStatus = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(
      STATUS_KEY,
      state.enabled ? `≤${state.wordLimit}w` : undefined,
    );
  };

  /** Save state to session */
  const save = (): void => {
    pi.appendEntry(STATE_ENTRY, {
      enabled: state.enabled,
      wordLimit: state.wordLimit,
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
    }
    setStatus(ctx);
  };

  /** Notify user about current settings */
  const notifySettings = (ctx: ExtensionContext): void => {
    if (!state.enabled) {
      ctx.ui.notify("Text generation limiter is OFF", "info");
      return;
    }
    ctx.ui.notify(`Text generation limiter ON: max ${state.wordLimit} words`, "info");
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

  // Truncate finalized assistant messages to apply the word limit.
  // `message_end` can return `{ message }` to replace the finalized message
  // (the replacement must keep the same role).
  pi.on("message_end", async (event) => {
    if (!state.enabled || event.message.role !== "assistant") return;
    const content = event.message.content;
    // Handle string content
    if (typeof content === "string") {
      const wordCount = countWords(content);
      if (wordCount > state.wordLimit) {
        return {
          message: {
            ...event.message,
            content: truncateText(content, state.wordLimit)
          }
        };
      }
      return;
    }

    // Handle array content (blocks): apply the limit across all text blocks
    if (Array.isArray(content)) {
      let remaining = state.wordLimit;
      let modified = false;
      const newContent = content.flatMap(block => {
        if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string") {
          // Budget exhausted: drop further text blocks entirely
          if (remaining <= 0) {
            modified = true;
            return [];
          }
          const wordCount = countWords(block.text);
          if (wordCount > remaining) {
            modified = true;
            const truncated = truncateText(block.text, remaining);
            remaining = 0;
            return [{ ...block, text: truncated }];
          }
          remaining -= wordCount;
        }
        return [block];
      });
      
      if (modified) {
        return {
          message: {
            ...event.message,
            content: newContent
          }
        };
      }
    }
  });

  // Cap assistant text while it streams (display only; stored message is unchanged).
  // An extension has one transformer, so this replaces any other one registered by this plugin.
  pi.registerMarkdownTransformer(
    (markdown, { messageType, isStreaming }) => {
      if (!state.enabled || messageType !== "assistant") return markdown;
      if (countWords(markdown) <= state.wordLimit) return markdown;
      const words = markdown.trim().split(/\s+/);
      return words.slice(0, state.wordLimit).join(" ") + (isStreaming ? "" : TRUNCATION_MARKER);
    },
    { messageTypes: ["assistant"] },
  );

  // Register command to control the limiter
  pi.registerCommand("textlimit", {
    description: "Control the text generation limiter",
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