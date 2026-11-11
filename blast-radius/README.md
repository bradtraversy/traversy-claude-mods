# Blast Radius

Blast Radius holds risky Bash commands before they run and shows what they would change: a recursive `rm`, a force push, or a database migration.

- In the terminal it opens a pane beside the chat, or a band above the prompt when the window is too narrow, with the command, what it would delete or overwrite, and Cancel and Proceed buttons.
- Where nothing can draw the hold, such as a session the desktop app hosts, the command goes to the app's own permission prompt instead, with a line saying what it would change. It waits there for your answer like any other approval, and auto mode does not answer it for you.
- In a `claude -p` run nobody can answer, so the command is refused.

Blast Radius is a fork of [blast-radius](https://github.com/hamzafer/claude-code-mods/tree/main/mods/blast-radius) by [Hamza Zafar](https://github.com/hamzafer), used under the MIT license. The hold, the previews and the band ordering are his. This version changes only what happens when no screen can show the hold: the original cancels the command at once, this one asks through the permission prompt.

## Install

Add the marketplace once, then install the mod:

```bash
claude plugin marketplace add bradtraversy/traversy-claude-mods
claude plugin install blast-radius@traversy-mods
```

Restart the session or enter `/reload-plugins` after installation. Run `/plugin` to confirm it is enabled. If you also have the original installed, disable it so only one of them holds commands.

## Options

A held command is cancelled after 60 seconds with no answer. Set `timeoutSeconds` to change that, or to `0` to wait for an answer forever:

```bash
claude plugin install blast-radius@traversy-mods --config timeoutSeconds=0
```

The timeout applies only to the pane and band. The permission prompt waits as long as any other approval does.

## Uninstall

```bash
claude plugin uninstall blast-radius@traversy-mods
```

## Source

[`hooks/register.tsx`](./hooks/register.tsx). Hamza Zafar's original copyright and MIT license are kept in [`LICENSE`](./LICENSE).
