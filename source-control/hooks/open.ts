// filetree's detached launch (claude-code-filetree hooks/open.ts): the command runs in its own
// session, and a launcher still alive after a second counts as started.
export const LINUX_LAUNCH = 'setsid -f -w "$@" </dev/null >/dev/null 2>&1 & p=$!; sleep 1; kill -0 "$p" 2>/dev/null && exit 0; wait "$p"'

// `code` is a snap, and a snap refuses to start under no_new_privs, which the desktop app can
// be left running with after an update. systemd-run starts it from the user's service manager.
export const OPEN_WITH = ['systemd-run', '--user', '--collect', '--quiet', '--same-dir', 'code', '-g']

export function openCommand(path: string, root: string) {
  return {
    argv: ['sh', '-c', LINUX_LAUNCH, 'sh', ...OPEN_WITH, path],
    init: { cwd: root, timeoutMs: 10_000 },
  }
}
