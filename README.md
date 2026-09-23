# Pi Choco Chips

Post-start enhancements for [pi](https://pi.dev), packaged as ordinary Pi extensions so Pi core does not depend on this project.

## Features

- Integrated dashboard with session title, model, context percentage/window, and cumulative agent-active time on the first footer line; project/Git context, optional detailed usage/cost, turn metadata, thinking summaries, tool timings, and system-event records.
- Bundled `adam-dark` Pi theme with an Atom One Dark palette and semantic dashboard colors.
- `/dashboard` — open a TUI settings page that toggles footer lines 2 and 3 and persists the choice.
- Compact transcript spacing and Bash command styling with runtime Pi capability detection. Unsupported internals disable only the affected feature and emit a warning.
- `/retitle` — generate a concise title from the current session.
- Compact at 80% context or 300K tokens, whichever comes first, before the next provider request, then resume the active turn automatically. Both numbers are settings, not constants; see [Compaction settings](#compaction-settings). Manual or threshold compaction after an assistant error also resumes; completed responses, Pi's overflow retry, and queued user messages are left alone.
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

or place the file under `PI_CODING_AGENT_DIR` when that environment variable is set. Each feature owns one top-level key. Dashboard settings live under the `dashboard` key:

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

User settings are deep-merged over the bundled defaults. The footer uses one responsive breakpoint: compact presentation below 60 columns and detail presentation at 60 columns or above. Compact presentation keeps title/model, the context percentage, a forced compact path, and extension statuses while hiding the context window, cache/time metrics, the redundant project name, Git status, usage, phase, and clock. Detail presentation restores those configured metrics and uses labeled `📁`, `cwd`, `git`, and `usage` fields. Footer line 3, which contains detailed token/cache/cost usage in detail presentation, is hidden by default and remains available through `/dashboard`. The footer packs complete fields onto each row and moves fields that do not fit to the next row instead of splitting them across lines. Compact paths use stable segment abbreviations without filesystem reads: important roots and the final two directories stay complete, while middle directories use initials (`Documents/work-src` becomes `D/w-s`); if that still does not fit, the earliest segments collapse behind `…`. Each extension owns its status key and content. The dashboard renders every non-empty status line in publication order and applies the same bounded packing behavior without interpreting extension-specific keys or text. Restart Pi after dashboard rendering or settings changes because the footer and compact transcript components are installed once per process.

### Compaction settings

Early compaction lives under the `compaction` key of the same file:

```json
{
  "version": 1,
  "compaction": {
    "triggerPercent": 80,
    "maxTokens": 300000
  }
}
```

| Key | Default | Meaning |
| --- | ---: | --- |
| `triggerPercent` | `80` | Percentage of the model's context window at which to compact. Must be in `(0, 100]`. |
| `maxTokens` | `300000` | Absolute token ceiling on that percentage. Must be positive. |

The effective trigger is `min(contextWindow × triggerPercent / 100, maxTokens)`, so the ceiling only binds on windows above `maxTokens / (triggerPercent / 100)` — about 375K at the defaults. A 872K window compacts at 300K, while a 372K window still compacts at 297.6K on the percentage alone. Either key can be set on its own; the other keeps its default. An out-of-range value falls back to the default for that key, and the session warns once instead of silently disabling early compaction. `/choco` reports the resolved pair as `compact-at=<percent>%/<maxTokens>`. Settings are read at extension registration, so restart Pi after changing them.
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

## Privacy

Use repository-relative paths or synthetic fixtures such as `/home/demo/project` in documentation, tests, and commit messages. Do not copy personal directory trees, real task identifiers, credentials, or private service addresses into public artifacts. Review Git author and committer email settings before publishing; use a hosting provider's noreply address if you do not want to publish a personal email. Deleting sensitive text in a later commit does not remove it from Git history.

PCC is not a redaction layer. Its local UI can display working directories, Git branches, task identifiers, and extension-provided status text. Automatic title generation and `/retitle` send selected conversation text to the currently selected model; set `dashboard.title.autoGenerate` to `false` to disable automatic title generation. Review screenshots and exported sessions before sharing them.


## Package

The package intentionally has no bundled runtime dependencies. Pi provides its core packages to extensions; the peer dependencies in `package.json` document the APIs used here.
