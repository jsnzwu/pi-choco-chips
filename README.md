# Pi Choco Chips

Small but tasty shortcuts and user-experience enhancements for [pi](https://pi.dev).

## Features

- `/retitle` — generate a concise title from the current session.
- Multiple `/skill:name` or `$skill-name` references in one prompt.
- Skill completion after `/skill:` or `$` anywhere in the current prompt.
- `/choco` — inspect or toggle the enhancements for the current session.

## Commands and skill references

`/command` selects a Pi command. `$skill-name` selects a skill without looking like a command; `/skill:name` remains supported as the explicit form.

```text
/retitle
/retitle focus on the current implementation

Use $git-comment-gen and /skill:ponytail in the same prompt.

/choco status
/choco on
/choco off
/choco retitle on
/choco skills off
/choco autocomplete on
```

The settings are stored as session entries, so a toggle survives `/reload` and follows a forked session without adding configuration files to the host.

## Install locally

```bash
pi install .
```

For development without installing:

```bash
pi -e ./extensions/index.js
```

After changing the extension in a running pi session:

```text
/reload
```

## Package

The package intentionally has no bundled runtime dependencies. Pi provides its core packages to extensions; the peer dependencies in `package.json` document the APIs used here.
