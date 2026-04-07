# stretchly-sync

Syncs [Stretchly](https://github.com/hovancik/stretchly) break reminders with AI coding agents. When a break is due, AI tool execution pauses until the break ends — no unaudited work.

A [Pi](https://github.com/can1357/oh-my-pi) extension. Claude Code and Codex support planned.

## Why

AI coding agents work fast. Without guardrails, they'll churn through dozens of tool calls while you're away on a break, producing work you never reviewed. This extension pauses tool execution during Stretchly breaks so you stay in the loop.

## How it works

1. **Session starts** -- pauses Stretchly's own timer, takes over scheduling
2. **Breaks are wall-clock aligned** (e.g., :00, :10, :20 with a 10-min interval)
3. **`setTimeout` fires at the exact scheduled time** -- no polling
4. **Tool calls within the early window** (default 30s) trigger the break at a clean boundary
5. **Triggers `stretchly mini`** (or `stretchly long`) via CLI
6. **Detects the break window** via Win32 `IsWindowVisible` API
7. **Blocks all tool execution** until the break window closes
8. **Also detects Stretchly's own breaks** reactively (if Stretchly fires one independently)
9. **Session ends** -- restores Stretchly's timer (with crash recovery)

Breaks fire whether the agent is actively working or sitting idle.

## Requirements

- Windows (break window detection uses Win32 API via PowerShell)
- [Stretchly](https://github.com/hovancik/stretchly) installed and running
- `stretchly` CLI on PATH (installed automatically with Stretchly)

## Install

### From GitHub Packages

```bash
npm install @ankitg12/stretchly-sync --registry=https://npm.pkg.github.com
```

### From source

```bash
git clone https://github.com/ankitg12/stretchly-sync.git
```

Then add to `~/.omp/agent/config.yml`:

```yaml
extensions:
  - ~/path/to/stretchly-sync
```

Restart your session to load.

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
  "earlyWindowMs": 30000,
  "debug": false
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `microbreakIntervalMs` | number | from Stretchly | Interval between micro breaks in ms |
| `longBreakAfter` | number | from Stretchly | Number of micro breaks before a long break |
| `earlyWindowMs` | number | `30000` | How early (ms) a tool call can trigger a break before the scheduled time. Set to `0` to only trigger at or after the exact time. |
| `debug` | boolean | `false` | Write debug log to `~/.omp/agent/stretchly-sync.log` |

All fields are optional. Omitted fields fall through to Stretchly's config or defaults.

## Usage

### Automatic breaks

Breaks trigger automatically at wall-clock boundaries. The status line shows:

```
Micro break -- paused (12s)
```

Tool execution resumes when the Stretchly break window closes.

### Manual breaks

Trigger a break from the prompt:

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

## Multi-session safety

Multiple Pi sessions can run simultaneously without conflicts:

- Breaks are wall-clock aligned, so every session computes the same schedule independently
- Reactive detection catches breaks triggered by any session
- If two sessions try to trigger at the same time, one succeeds, the other detects the existing window

## Crash recovery

Three layers ensure Stretchly is always restored:

1. `session_shutdown` handler (normal exit)
2. `process.on('exit')` trap (Ctrl+C, SIGTERM, crash)
3. Resume-before-pause on next session start (SIGKILL, terminal close)

## Limitations

- **Windows only** -- break window detection uses Win32 `IsWindowVisible` via PowerShell. macOS/Linux support would need a different detection mechanism.
- **Tool-call granularity** -- breaks fire between tool calls, not mid-execution. If a long bash command is running, it finishes before the pause takes effect.
- **No mid-stream pause** -- if the LLM is generating text (no tool calls), the response completes before the next tool call is blocked.

## License

MIT
