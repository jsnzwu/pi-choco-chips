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

The package ships defaults in [`pi-choco-setting.toml`](pi-choco-setting.toml). To override them, create:

```text
~/.pi/agent/pi-choco-setting.toml
```

or place the file under `PI_CODING_AGENT_DIR` when that environment variable is set. Each feature owns one top-level key. Dashboard settings live under the `dashboard` key:

```toml
[dashboard]
enabled = true

[dashboard.footer]
line2Visible = true
line3Visible = false

[dashboard.transcript]
compactSameTurnSpacing = true
```

Only TOML configuration is supported; `pi-choco-setting.json` is ignored. Convert existing JSON overrides to TOML before restarting Pi. Keep only fields you want to override rather than copying bundled defaults. `/dashboard` saves only differences from the defaults and preserves other settings, but normalizes TOML formatting and does not retain comments. Returning a setting to its default removes that override.

User settings are deep-merged over the bundled defaults. The footer keeps the title on the left before allocating space to the model and metrics on the right. As space decreases, it hides elapsed time, cache hit rate, context capacity, and context percentage in that order; numeric fields are displayed whole or omitted, not truncated. Compact presentation below 60 columns omits detail metrics and field labels while retaining the configured path and Git branch. Detail presentation restores configured information as space permits. Footer line 3, containing detailed token/cache/cost usage, is hidden by default and remains available through `/dashboard`.

Paths shorten leading directories to initials without filesystem reads and preserve the final two directories when possible, for example `/mnt/d/Workspace/source-code/projects/demo-app` becomes `/m/d/W/s/projects/demo-app`. Tighter widths shorten the penultimate directory and then omit leading directories. Git compression first hides zero counters and the field label, abbreviates leading branch words separated by `/`, `-`, or `_`, and omits nonzero counters only when needed. Branch suffix words and the dirty `*` marker take priority; counts are never partially displayed. Configured path and Git fields do not disappear merely because the terminal crosses the compact breakpoint.

The footer defaults to Nerd Font folder (U+F114), branch (U+E725), and model/robot (U+F06A9) glyphs. Project names have no emoji prefix. Labels and icons disappear before sacrificing field content. Start Pi with `PI_GLYPH_MODE=ascii` for ASCII footer labels, separators, Git arrows, and ellipses; other extension-owned surfaces and user content are unchanged. This is a PCC/MiAW convention, not automatic font detection.

Built-in footer rows remain bounded single lines. Extension statuses follow on their own bounded row, except that the native `mcp` status is placed on the second row without duplication. Reload Pi after changing the extension source; a full restart is recommended if an already-installed custom component still shows the old rendering. Settings changes require restarting Pi.

### Compaction settings

Early compaction lives under the `compaction` key of the same file:

```toml
[compaction]
triggerPercent = 80
maxTokens = 300000
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

The package uses `smol-toml` to parse and serialize configuration. Pi provides its core packages to extensions; the peer dependencies in `package.json` document the APIs used here.
