# Traversy Claude Mods

Three small Claude Code mods for long sessions: a telemetry strip above the prompt, cleaner tool-use cards in the transcript, and suggested next prompts after each turn. All three work in the terminal and in the Code tab of Claude Desktop.

```bash
claude plugin marketplace add bradtraversy/traversy-claude-mods
claude plugin install session-hud@traversy-mods
claude plugin install tool-cards@traversy-mods
claude plugin install next-steps@traversy-mods
```

> [!IMPORTANT]
> Mods run inside Claude Code with your user permissions. They can see session events, start processes, access files, and make network requests. Read the source before installing any mod, including these.

## Included mods

### [Session HUD](./session-hud/README.md)

A compact strip above the prompt with your Git branch, context usage against a target you choose, and weekly account usage. Select `Details` for a full context breakdown, five-hour and weekly limits, and session cost.

![Session HUD telemetry strip above the prompt](./docs/images/session-hud.png)

```bash
claude plugin install session-hud@traversy-mods
```

[Read the Session HUD guide](./session-hud/README.md)

### [Tool Cards](./tool-cards/README.md)

Replaces Claude Code's tool-use rows with clean cards that show the action, status, tool, timing, and result. Output stays collapsed behind `Details` until you want it, and failures open automatically.

![Tool Cards showing a completed Bash command](./docs/images/tool-cards.png)

```bash
claude plugin install tool-cards@traversy-mods
```

[Read the Tool Cards guide](./tool-cards/README.md)

### [Next Steps](./next-steps/README.md)

After each turn, two or three likely next prompts appear above the prompt. On the desktop each one is a button that drafts it into the prompt box. In the terminal, press 1, 2 or 3 in an empty prompt. Each suggestion round is one small Haiku call. A fork of [next-steps](https://github.com/hamzafer/claude-code-mods/tree/main/mods/next-steps) by [Hamza Zafar](https://github.com/hamzafer), with desktop buttons added.

```bash
claude plugin install next-steps@traversy-mods
```

[Read the Next Steps guide](./next-steps/README.md)

The images show the mods in Claude Desktop. Exact spacing and colors can vary by platform and Claude version.

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
claude plugin install next-steps@traversy-mods
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

Tool Cards owns tool-use rows in the transcript. Session HUD and Next Steps share the band above the prompt: each passes on what the other draws, so the suggestions sit above the telemetry strip.

## Develop locally from scratch

You do not need Node.js, a bundler, or a dependency installation. Claude Code loads TypeScript mod files directly and supplies the test runner.

### 1. Clone the repository

```bash
git clone https://github.com/bradtraversy/traversy-claude-mods.git
cd traversy-claude-mods
```

### 2. Validate the marketplace and the mods

```bash
claude plugin validate .
claude plugin validate ./session-hud
claude plugin validate ./tool-cards
claude plugin validate ./next-steps
```

Validation reads the mod without executing it. Review the reported `hooks:` and `calls:` lines to see what it handles and which Claude Code APIs it uses.

### 3. Run the automated tests

```bash
claude plugin test ./session-hud
claude plugin test ./tool-cards
claude plugin test ./next-steps
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

Then install the mods from `traversy-mods`. Claude Code runs a copy of each mod taken at install or update time, keyed by its `version`, not the folder itself. To load an edit, bump the mod's `version` in `.claude-plugin/plugin.json`, then run `claude plugin marketplace update traversy-mods` and `claude plugin update <mod>@traversy-mods`, and start a new session. For quick iteration without version bumps, use `--plugin-dir` as in step 4.

This is the easiest development setup for sharing the exact same working directory between terminal sessions and local desktop Code sessions.

## Anatomy of each mod

Each directory follows the same basic structure:

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

A local marketplace needs the same update command after you pull, since the installed copy only changes when the mod's `version` does.

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

The mods are intentionally small enough to inspect directly. Next Steps sends your last few messages to Haiku after each turn.

## Documentation

- [Claude Code mods overview](https://code.claude.com/docs/en/plugins/mods/overview)
- [Create a mod](https://code.claude.com/docs/en/plugins/mods/create)
- [Test a mod](https://code.claude.com/docs/en/plugins/mods/test)
- [Create a plugin marketplace](https://code.claude.com/docs/en/plugins/create-marketplace)
- [Host and maintain a marketplace](https://code.claude.com/docs/en/plugins/host-marketplace)

## License

MIT
