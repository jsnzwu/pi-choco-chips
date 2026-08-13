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

User settings are deep-merged over the bundled defaults. Footer line 3, which contains detailed token/cache/cost usage, is hidden by default and remains available through `/dashboard`. Extension status values containing newlines render as separate bounded rows at the bottom of the footer. Restart Pi after changing dashboard settings because compact transcript rendering patches Pi's runtime components once per process.

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
