# pi-text-generation-limiter

A simple [pi](https://pi.dev) extension that provides gentle text generation limiting without aggressive system prompts or hard token limits.

Unlike heavy-handed solutions, this extension focuses on a lightweight approach to controlling output length by simply truncating overly long text rather than forcing complex system instructions or hard limits.

## Features

- **One limit, three surfaces**: a single word limit covers chat text, model reasoning, and tool call output
- **Lower cost**: tool output is truncated before it is sent back to the model, so it stops re-reading long outputs every turn
- **No Aggressive Prompts**: doesn't inject system instructions or change model behavior
- **Simple controls**: one command, one number

## Installation

Copy `index.ts` into `~/.pi/agent/extensions/` for auto-discovery. Run `/reload` or restart pi after installing.

## Usage

```text
> /textlimit 100
> Explain quantum computing.
Quantum computers use qubits... (automatically truncated if over 100 words)
```

### Commands

| Command | Result |
|---|---|
| `/textlimit <n>` | Turn on with an `n`-word limit (`1`–`500`) |
| `/textlimit` or `/textlimit status` | Show whether the limiter is on or off, and the current limit |
| `/textlimit on` / `/textlimit off` | Turn on (current limit) / off |
| `/textlimit toggle` | Flip on ⇄ off |
| `Ctrl+Alt+L` | Toggle on ⇄ off |

The footer shows `≤<n>w` while on. The limit and on/off state persist across sessions.

### What the limit applies to

When on, the same word limit is applied to:

1. **Chat text**: assistant text, truncated when the message is finalized (and capped while it streams).
2. **Reasoning (thinking)**: the stored/displayed thinking text is capped. This limits only the text, never the reasoning tokens, so the model can finish its reasoning.
3. **Tool output**: text returned by tool calls (e.g. `bash`, `read`, search output) is truncated before it is sent back to the model. This shrinks the context re-read on every later turn, which is where the cost saving comes from. Image blocks pass through, and error results are left intact so failures stay readable.

Each surface gets its own budget of `n` words (chat, reasoning, and each tool result are counted separately). Truncated text ends with a `(text truncated by limiter)` marker.

## How It Works

When enabled, the extension post-processes outgoing text. It never injects system prompts or modifies how the model is run; it only truncates what is stored, displayed, or returned to the model.

## License

[MIT](LICENSE)
