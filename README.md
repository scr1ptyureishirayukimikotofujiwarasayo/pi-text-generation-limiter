# pi-text-generation-limiter

A simple [pi](https://pi.dev) extension that provides gentle text generation limiting without aggressive system prompts or hard token limits.

Unlike heavy-handed solutions, this extension focuses on a lightweight approach to controlling output length by simply truncating overly long responses rather than forcing complex system instructions or hard limits.

## Features

- **Soft Word Limiting**: Gently limits the length of generated text by truncating responses that exceed your specified word limit
- **No Aggressive Prompts**: Doesn't inject harsh system instructions that might affect model behavior
- **Simple Controls**: Easy on/off toggle with customizable word limits
- **Unobtrusive**: Only activates when you want it to, with clear status indicators

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
| `/textlimit` or `/textlimit status` | Show whether the limiter is **on** or **off**, plus the current word limit |
| `/textlimit toggle` | Flip **on ⇄ off** |
| `/textlimit on` | Turn on with the default limit (`100` words) |
| `/textlimit off` | Turn off |
| `/textlimit 250` | Turn on with a 250-word limit (`1`–`500` words) |
| `Ctrl+Alt+L` | Toggle **on ⇄ off** |

The footer shows `≤<n>w` (word limit) while on.

### Reasoning limit

The same word limiting can be applied to a model's **reasoning** (thinking) text, with its own budget independent of the chat limit. This caps only the *displayed/stored thinking text*; it never caps reasoning tokens, so the model can finish its reasoning and tasks are not interrupted.

| Command | Result |
|---|---|
| `/textlimit think` or `/textlimit think toggle` | Flip reasoning limiter on ⇄ off |
| `/textlimit think on` / `think off` | Turn reasoning limiter on / off |
| `/textlimit think 150` | Turn on with a 150-word reasoning limit (`1`–`500`) |
| `Ctrl+Alt+R` | Toggle reasoning limiter on ⇄ off |

The footer shows `think≤<n>w` while on. The chat and reasoning limits are independent and both persist across sessions. `/textlimit status` shows both.

### How It Works

When enabled, the extension monitors outgoing assistant messages and automatically truncates any text blocks that exceed your specified word limit. The truncation is marked with a `(text truncated by limiter)` indicator so you know when it has been applied.

The extension does not inject any system prompts or modify model behavior - it simply post-processes the output to keep it within your specified limits.

## Configuration

The extension maintains its state across sessions, so your settings will persist between restarts.

## License

[MIT](LICENSE)