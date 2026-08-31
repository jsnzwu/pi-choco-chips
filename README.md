# Pi Choco Chips

Post-start enhancements for [pi](https://pi.dev), packaged as ordinary Pi extensions so Pi core does not depend on this project.

## Features

- Integrated dashboard with session title, model, context percentage/window, and cumulative agent-active time on the first footer line; project/Git context, optional detailed usage/cost, turn metadata, thinking summaries, tool timings, and system-event records.
- Bundled `adam-dark` Pi theme with an Atom One Dark palette and semantic dashboard colors.
- `/dashboard` — open a TUI settings page that toggles footer lines 2 and 3 and persists the choice.
- Compact transcript spacing and Bash command styling with runtime Pi capability detection. Unsupported internals disable only the affected feature and emit a warning.
- `/retitle` — generate a concise title from the current session.
- Compact at 80% context before the next provider request, then resume the active turn automatically. Manual or threshold compaction after an assistant error also resumes; completed responses, Pi's overflow retry, and queued user messages are left alone.
- Multiple `/skill:name` or `$skill-name` references in one prompt, delivered as one ordered custom message.
- Skill completion after `/skill:` or `$` anywhere in the current prompt.
- Consistent composer controls: Enter submits or steers an active turn, Alt+Enter queues a follow-up, and Shift+Enter inserts a newline. Ctrl+J remains the terminal-safe newline fallback.
- `/choco` — open a TUI settings page for all shortcut enhancements; command-line status and toggles remain available.

The dashboard, shortcut extension, and `adam-dark` theme are loaded from this package as one post-start enhancement layer. Select `adam-dark` through `/settings` or set `"theme": "adam-dark"` in Pi settings.

## Settings

The package ships defaults in [`pi-choco-setting.json`](pi-choco-setting.json). To override them, create:

```text
~/.pi/agent/pi-choco-setting.json
```

or place the file under `PI_CODING_AGENT_DIR` when that environment variable is set. Dashboard settings live under the `dashboard` key:

```json
{
  "version": 1,
  "dashboard": {
    "enabled": true,
    "footer": {
      "line2Visible": true,
      "line3Visible": false
    },
    "transcript": {
      "compactSameTurnSpacing": true
    }
  }
}
```

User settings are deep-merged over the bundled defaults. The footer uses one responsive breakpoint: compact presentation below 100 columns and detail presentation at 100 columns or above. Compact presentation keeps title/model, a forced compact path, and extension statuses while hiding context/cache/time metrics, the redundant project name, Git status, usage, phase, and clock. Detail presentation restores those configured metrics and uses labeled `📁`, `cwd`, `git`, and `usage` fields. Footer line 3, which contains detailed token/cache/cost usage in detail presentation, is hidden by default and remains available through `/dashboard`. The footer packs complete fields onto each row and moves fields that do not fit to the next row instead of splitting them across lines. Compact paths use stable segment abbreviations without filesystem reads: important roots and the final two directories stay complete, while middle directories use initials (`Nextcloud/sync-git` becomes `N/s-g`); if that still does not fit, the earliest segments collapse behind `…`. Weyaw publishes task status as `<canonical-task-id> · <visible-count> AGT`. The dashboard groups the `weyaw` and `mcp` keys as `<truncated-task-id> · <visible-count> AGT · MCP`, reserves the AGT/MCP suffix, and truncates only the task id by terminal display cells when the combined row is long. If the marker fields themselves cannot share one row, normal whole-field wrapping keeps their order without splitting a marker. Project-only Weyaw text and multiline or unrelated extension statuses retain the generic bounded packing behavior. Restart Pi after dashboard rendering or settings changes because the footer and compact transcript components are installed once per process.

## Commands and skill references

`/command` selects a Pi command. `$skill-name` selects a skill without looking like a command; `/skill:name` remains supported as the explicit form.

```text
/retitle
/retitle focus on the current implementation

Use $git-comment-gen and /skill:ponytail in the same prompt.

/dashboard

/choco
/choco status
/choco on
/choco off
/choco retitle on
/choco skills off
/choco autocomplete on
/choco compact-resume off
```

The `/choco` toggles are stored as session entries, so they survive `/reload` and follow forked sessions without changing host configuration.

## Install locally

From the repository root:

```bash
pi install .
```

For development without installing:

```bash
pi -e ./extensions/index.ts -e ./extensions/dashboard.ts
```

After changing only shortcut logic, `/reload` is sufficient. After changing dashboard rendering or settings, restart Pi.

## Package

The package intentionally has no bundled runtime dependencies. Pi provides its core packages to extensions; the peer dependencies in `package.json` document the APIs used here.
