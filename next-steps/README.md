# Next Steps

Next Steps suggests two or three likely next prompts after each turn and shows them above the prompt.

- On the desktop each suggestion is a button. Click one to put it in the prompt box, where you can edit it before sending. The Dismiss suggestions button clears them.
- In the terminal they show as a numbered line. Press 1, 2 or 3 in an empty prompt to draft one, or 0 to dismiss.
- Nothing is ever sent on its own.

Next Steps is a fork of [next-steps](https://github.com/hamzafer/claude-code-mods/tree/main/mods/next-steps) by [Hamza Zafar](https://github.com/hamzafer), used under the MIT license. The suggestion logic, terminal layout and band ordering are his. This version adds the desktop buttons.

## Install

Add the marketplace once, then install the mod:

```bash
claude plugin marketplace add bradtraversy/traversy-claude-mods
claude plugin install next-steps@traversy-mods
```

Restart the session or enter `/reload-plugins` after installation. Run `/plugin` to confirm it is enabled.

## How it works

When a turn ends with a reply, Next Steps sends the last few messages and the reply to Haiku and asks for two or three short follow-up prompts. That is one small model call per turn. It waits while background agents are still running, and it skips very short replies. The suggestions clear as soon as you submit a prompt or a new turn starts.

To get the suggestions in another language, set the `language` option:

```bash
claude plugin install next-steps@traversy-mods --config language=Korean
```

## Uninstall

```bash
claude plugin uninstall next-steps@traversy-mods
```

## Source

[`hooks/register.tsx`](./hooks/register.tsx). Hamza Zafar's original copyright and MIT license are kept in [`LICENSE`](./LICENSE).
