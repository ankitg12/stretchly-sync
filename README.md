# stretchly-sync

Syncs [Stretchly](https://github.com/hovancik/stretchly) break reminders with AI coding agents. When Stretchly triggers a break, AI tool execution pauses until the break ends.

Built for [Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp`). Claude Code and Codex support planned.

## Why

AI coding agents work fast. Without guardrails, they'll churn through dozens of tool calls while you're away on a break, producing work you never reviewed. This extension pauses tool execution during Stretchly breaks so you stay in the loop.

## How it works

1. **Session starts** -- pauses Stretchly's own timer and takes over scheduling
2. **Background timer** checks every 30 seconds if a break is due
3. **Tool calls** also check and block if a break is active
4. **Triggers `stretchly mini`** (or `stretchly long`) via CLI
5. **Detects the break window** via PowerShell process inspection
6. **Blocks all tool execution** until the break window closes
7. **Session ends** -- restores Stretchly's own timer

Breaks fire whether the agent is actively working or sitting idle.

## Requirements

- Windows (break window detection uses PowerShell)
- [Stretchly](https://github.com/hovancik/stretchly) installed and running
- `stretchly` CLI on PATH (installed automatically with Stretchly)

## Install

### omp

Add to `~/.omp/agent/config.yml`:

```yaml
extensions:
  - ~/path/to/stretchly-sync
```

Or clone and reference:

```bash
git clone https://github.com/ankitg12/stretchly-sync.git
```

```yaml
extensions:
  - ~/stretchly-sync
```

Restart your omp session to load.

## Configuration

The extension reads break timing from three sources (highest priority wins):

| Source | Location | Purpose |
|--------|----------|---------|
| Local override | `~/.omp/agent/stretchly-sync.json` | Per-user override |
| Stretchly config | `%APPDATA%/Stretchly/config.json` | Stretchly's own settings |
| Built-in defaults | (hardcoded) | 10 min interval, long break after 9 micros |

### Local override

Create `~/.omp/agent/stretchly-sync.json`:

```json
{
  "microbreakIntervalMs": 600000,
  "longBreakAfter": 9,
  "debug": false
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `microbreakIntervalMs` | number | from Stretchly | Interval between micro breaks in ms |
| `longBreakAfter` | number | from Stretchly | Number of micro breaks before a long break |
| `debug` | boolean | `false` | Write debug log to `~/.omp/agent/stretchly-sync.log` |

All fields are optional. Omitted fields fall through to Stretchly's config or defaults.

## Usage

### Automatic breaks

Breaks trigger automatically at the configured interval. The status line shows:

```
Micro break -- paused (12s)
```

Tool execution resumes when the Stretchly break window closes.

### Manual breaks

Trigger a break from the omp prompt:

```
/break        # micro break
/break long   # long break
```

### Debugging

Enable debug logging:

```json
{ "debug": true }
```

Then check `~/.omp/agent/stretchly-sync.log` for timing, window detection, and CLI output.

## Limitations

- **Windows only** -- break window detection uses `Get-Process` via PowerShell. macOS/Linux support would need a different detection mechanism.
- **Tool-call granularity** -- breaks fire between tool calls, not mid-execution. If a long bash command is running, it finishes before the pause takes effect. The background timer ensures breaks still trigger during idle periods.
- **No mid-stream pause** -- if the LLM is generating text (no tool calls), the response completes before the next tool call is blocked.

## License

MIT
