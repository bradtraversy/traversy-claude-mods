# Traversy Claude Mods

Claude Code mods by Brad Traversy. Session HUD adds a compact telemetry strip above the prompt, and Tool Cards replaces tool-use rows with cleaner diagnostic cards.

Each mod is a small, independent Claude Code plugin written in TypeScript. Install one or both.

> [!IMPORTANT]
> Mods run inside Claude Code with your user permissions. They can see session events, start processes, access files, and make network requests. Read the source before installing any mod, including these.

## Included mods

| Mod | What it does | How to open or test it |
| --- | --- | --- |
| [Session HUD](./session-hud/README.md) | Shows branch safety, context headroom, and weekly usage in a compact telemetry strip | Switch branches or select `Details` beside the context meter |
| [Tool Cards](./tool-cards/README.md) | Replaces normal tool-use rows with diagnostic cards for status, timing, results, and details | Ask Claude to read a file, edit code, or run a command |

Each mod README contains its installation command, usage guide, test steps, and interface images. The images are source-accurate mockups of the current mods in Claude Desktop. Exact spacing and colors can vary by platform and Claude version.

## What is a mod?

A mod is a Claude Code plugin with JavaScript or TypeScript event handlers. Claude Code calls those handlers when something happens, such as:

- A session starts
- Claude calls a tool
- A command is submitted
- Part of the interface is rendered
- Context usage changes

A handler can observe the event, change it, or handle it completely. That makes mods different from normal settings hooks. A mod can draw interface elements, replace existing tool rows, register slash commands, share state between handlers, and intercept a tool call before it runs.

These mods work in:

- Claude Code in a terminal
- Local sessions in the Code tab of the Claude Desktop app
- SSH sessions in the Code tab when plugins are available on the remote host

Visual elements do not appear in the VS Code chat panel, `claude -p`, Agent SDK sessions, or cloud sessions. Plugins are not available in WSL sessions opened through the desktop app.

## Requirements

- Claude Code 2.1.287 or newer for terminal use
- A desktop app version that includes Claude Code 2.1.286 or newer for the Code tab
- Git, so Claude Code can clone this marketplace

Check your terminal version:

```bash
claude --version
```

In the desktop Code tab, enter `/status` and check the Claude Code version.

## Quick start

### 1. Add the marketplace

Run this in your shell:

```bash
claude plugin marketplace add bradtraversy/traversy-claude-mods
```

You can also enter this in a Claude Code session:

```text
/plugin marketplace add bradtraversy/traversy-claude-mods
```

### 2. Install the mods you want

```bash
claude plugin install session-hud@traversy-mods
claude plugin install tool-cards@traversy-mods
```

Inside an interactive session, the same commands start with `/plugin install` instead of `claude plugin install`.

### 3. Load the mods

Start a new Claude Code session. If a session was already open when you installed or updated a mod, enter:

```text
/reload-plugins
```

Run `/plugin` and open the Installed tab to confirm that the mods are enabled.

## Use the same mods in terminal and desktop

Claude Code in the terminal and local sessions in the desktop Code tab share user-scoped plugin settings. Install a mod once at user scope and it is available in both places.

For the desktop app:

1. Open the Code tab.
2. Start a local session.
3. Enter `/reload-plugins`, or start a new session after installation.
4. Enter `/plugin` and confirm the mod is listed as active.

You can also use the desktop plugin manager. Click the plus button beside the prompt, choose Plugins, and use Manage plugins to enable or disable an installed mod.

## How the mods work together

Session HUD owns the band above the prompt and Tool Cards owns tool-use rows in the transcript. They use different interface regions, so nothing overlaps.

## Develop locally from scratch

You do not need Node.js, a bundler, or a dependency installation. Claude Code loads TypeScript mod files directly and supplies the test runner.

### 1. Clone the repository

```bash
git clone https://github.com/bradtraversy/traversy-claude-mods.git
cd traversy-claude-mods
```

### 2. Validate the marketplace and both mods

```bash
claude plugin validate .
claude plugin validate ./session-hud
claude plugin validate ./tool-cards
```

Validation reads the mod without executing it. Review the reported `hooks:` and `calls:` lines to see what it handles and which Claude Code APIs it uses.

### 3. Run the automated tests

```bash
claude plugin test ./session-hud
claude plugin test ./tool-cards
```

The interface tests mount each mod on simulated terminal and desktop surfaces.

### 4. Load one mod for a development session

```bash
claude --plugin-dir ./session-hud
```

Claude Code watches a directory loaded with `--plugin-dir` and reloads the hooks module after changes. Run `/plugin` to confirm that the mod loaded.

Repeat the flag to load both:

```bash
claude --plugin-dir ./session-hud --plugin-dir ./tool-cards
```

### 5. Use the local checkout in terminal and desktop

Register the clone itself as a local marketplace:

```bash
claude plugin marketplace add /absolute/path/to/traversy-claude-mods
```

Then install either mod from `traversy-mods`. A marketplace added from a local directory reads these relative plugin directories in place, so edits appear after a new session starts or after `/reload-plugins`.

This is the easiest development setup for sharing the exact same working directory between terminal sessions and local desktop Code sessions.

## Anatomy of each mod

Both directories follow the same basic structure:

```text
mod-name/
├── .claude-plugin/
│   ├── plugin.json
│   └── types/
│       ├── .gitignore
│       └── tsconfig.json
├── hooks/
│   ├── hooks.json
│   ├── config.ts       # only when the mod has user-editable settings
│   └── register.tsx
├── tests/
│   └── mod-name.test.ts
└── tsconfig.json
```

### `plugin.json`

The plugin manifest provides the mod name, version, description, and author.

### `hooks.json`

This file points Claude Code to the TypeScript module that registers the event handlers.

### `register.tsx`

The module imports the `Register` type from `claude-code` and exports a `register` function:

```ts
import type { Register } from 'claude-code'

export const register: Register = on => {
  on('session.start', ($, event, next) => {
    return next(event)
  })
}
```

The `Register` type comes from declarations generated by Claude Code in `.claude-plugin/types/`. Those declarations also provide types for `$`, `event`, and `next`, which removes the red lines an editor would otherwise show for the `claude-code` import and handler parameters.

Do not install a package named `claude-code` from npm for these types. Load the mod once with `--plugin-dir`, and Claude Code writes declarations that match the version you are actually running.

### Tests

Tests import from `claude-code/testing`. They fire events without running a real tool, network request, or Claude session.

## Updating

Update one installed mod from the shell:

```bash
claude plugin update session-hud@traversy-mods
```

Then restart the session or enter `/reload-plugins`.

Developers working from a local marketplace do not need an update command. Pull the repository and reload the plugins.

## Disable or uninstall a mod

Open `/plugin`, select the Installed tab, and disable or uninstall the mod.

From the shell:

```bash
claude plugin disable session-hud@traversy-mods
claude plugin uninstall session-hud@traversy-mods
```

## Troubleshooting

### The mod does not appear

- Check `claude --version` or `/status`.
- Run `/plugin` and confirm the mod is installed and enabled.
- Enter `/reload-plugins` after installing or editing it.
- Make sure the current workspace is trusted.
- Make sure Claude Code was not started with `--safe-mode` or `--bare`.
- Check that `disableAllHooks` is not enabled in your Claude Code settings.

### The editor shows red lines under `claude-code` or handler parameters

Load the mod once in an interactive session:

```bash
claude --plugin-dir ./path-to-mod
```

Claude Code generates `.claude-plugin/types/` and a compatible `tsconfig.json`. Make sure your editor has opened the mod directory or a parent workspace that includes it.

### A mod works in the terminal but not another surface

Mods can run hooks in more places than they can draw. Use a terminal or a local session in the desktop Code tab. The VS Code chat panel and non-interactive sessions do not display custom bands or replaced rows.

## Security notes

Claude Code mods are not sandboxed. Before loading a mod, run:

```bash
claude plugin validate ./path-to-mod
```

Read the reported handlers and API calls, then inspect the source. A mod can potentially read files and environment variables, start processes, make network requests, observe prompts and tool calls, alter session behavior, and spend model usage.

Both mods are intentionally small enough to inspect directly.

## Documentation

- [Claude Code mods overview](https://code.claude.com/docs/en/plugins/mods/overview)
- [Create a mod](https://code.claude.com/docs/en/plugins/mods/create)
- [Test a mod](https://code.claude.com/docs/en/plugins/mods/test)
- [Create a plugin marketplace](https://code.claude.com/docs/en/plugins/create-marketplace)
- [Host and maintain a marketplace](https://code.claude.com/docs/en/plugins/host-marketplace)

## License

MIT
