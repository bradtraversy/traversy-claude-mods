import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, Timer } from 'claude-code'

import type { Change, Commit, CommitFile, Confirm, Diff, DiffTarget, Group, Repo, Scm } from '../types'
import { changeDiffArgs, changeSides, commitDiffArgs, commitFilesArgs, commitSides, diffHunks, discardAllArgs, discardArgs, firstLine, LOG_FORMAT, parseLog, parseNameStatus, parseStatus, splitPath, stageArgs, unstageAllArgs, unstageArgs } from './git'
import type { Side } from './git'
import { graphWidth, layout, passSvg, pillSvg, REF_COLOR, REMOTE_COLOR, ROW_HEIGHT, rowSvg, textGraph } from './graph'
import { fileSvgs, ICON_SIZE } from './icons'
import { BADGE_BG, BADGE_FG, fileIcon, HOVER_BG, letterColor, SELECTED_BG, WARN } from './look'
import { diffCommand, openCommand } from './open'

const PANE = 'source-control'
const TITLE = 'Source Control'
const DIFF_PANE = 'source-control-diff'
// A Code drawing holds 100,000 characters, and a diff cut mid-hunk does not parse.
const MAX_DIFF = 100_000
const PAGE = 50
const MAX_ROWS = 300
const MAX_CACHED = 40
const OPEN_FILE = '↗'

// Change the tag when Scm's fields change: it declines what an earlier version stored.
const scm = atom({ plugin: 'source-control', key: 'scm' } as const, { repo: null, error: '' } as Scm, { shape: 'scm-1' })
const draft = atom({ plugin: 'source-control', key: 'draft' } as const, '')
const field = atom({ plugin: 'source-control', key: 'field' } as const, 0)
const collapsed = atom({ plugin: 'source-control', key: 'collapsed' } as const, [] as string[])
const confirm = atom({ plugin: 'source-control', key: 'confirm' } as const, null as Confirm | null)
const busy = atom({ plugin: 'source-control', key: 'busy' } as const, '')
const limit = atom({ plugin: 'source-control', key: 'limit' } as const, PAGE)
const expanded = atom({ plugin: 'source-control', key: 'expanded' } as const, [] as string[])
const files = atom({ plugin: 'source-control', key: 'files' } as const, {} as Record<string, CommitFile[]>, { shape: 'files-1' })
const diff = atom({ plugin: 'source-control', key: 'diff' } as const, null as Diff | null, { shape: 'diff-1' })

const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

type Run = { args: string[]; stdin?: string }

function git($: EngineInterface, root: string, run: Run, timeoutMs = 20_000) {
  return $.process.run(['git', '--no-optional-locks', '-C', root, ...run.args], {
    timeoutMs,
    env: { GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0' },
    ...(run.stdin === undefined ? {} : { stdin: run.stdin }),
  })
}

async function load($: EngineInterface): Promise<Scm> {
  const cwd = await $.session.cwd()
  const top = await git($, cwd, { args: ['rev-parse', '--show-toplevel'] }, 5_000)
  if (top.exitCode !== 0) return { repo: null, error: `${cwd} is not in a git repository.` }
  const root = top.stdout.trim()
  const st = await git($, root, { args: ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all'] })
  if (st.exitCode !== 0) return { repo: null, error: firstLine(st.stderr) || 'git status failed.' }
  const status = parseStatus(st.stdout)
  let log: Pick<Repo, 'commits' | 'rows'> = { commits: [], rows: [] }
  if (status.hasHead) {
    const count = await read($, limit)
    const refs = ['HEAD', ...(status.upstream ? [status.upstream] : [])]
    const run = await git($, root, { args: ['log', '--graph', '--decorate=full', `--max-count=${count}`, `--format=${LOG_FORMAT}`, ...refs, '--'] })
    if (run.exitCode === 0) log = parseLog(run.stdout)
  }
  return { repo: { root, ...status, ...log }, error: '' }
}

let running: Promise<void> | null = null
let again = false

/** Reads the repo again; a call while one runs makes that one go once more. */
function refresh($: EngineInterface): Promise<void> {
  if (running) {
    again = true
    return running
  }
  running = (async () => {
    do {
      again = false
      let next: Scm
      try {
        next = await load($)
      } catch (err) {
        next = { repo: null, error: err instanceof Error ? err.message : String(err) }
      }
      await update($, scm, () => next)
    } while (again)
    // An open diff follows the repo, as VS Code's diff editor does.
    const shown = await read($, diff)
    if (shown) await fillDiff($, shown.target)
  })().finally(() => {
    running = null
  })
  return running
}

let timer: Timer | null = null

function schedule($: EngineInterface, ms = 300): void {
  if (timer) return
  timer = $.clock.after(ms, () => {
    timer = null
    void refresh($)
  })
}

/** Runs git commands in order, stopping at the first that fails, then reads the repo again. */
async function act($: EngineInterface, label: string, root: string, runs: Run[]): Promise<boolean> {
  await update($, busy, () => label)
  try {
    for (const run of runs) {
      const done = await git($, root, run, 120_000)
      if (done.exitCode !== 0) {
        $.ui.toast(`${label} failed: ${firstLine(done.stderr) || firstLine(done.stdout) || `git exited ${done.exitCode}`}`)
        return false
      }
    }
    return true
  } catch (err) {
    $.ui.toast(`${label} failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  } finally {
    await update($, busy, () => '')
    await refresh($)
  }
}

async function openFile($: EngineInterface, root: string, change: Change): Promise<void> {
  if (change.letter === 'D') {
    $.ui.toast(`${splitPath(change.path).name} is deleted, so there is no file to open.`)
    return
  }
  await openInCode($, root, change.path)
}

/** A commit's file opens as it is in the working tree now, as long as it is still there. */
async function openCommitFile($: EngineInterface, root: string, file: CommitFile): Promise<void> {
  const isThere = await $.fs.stat(`${root}/${file.path}`).then(
    stat => stat.kind === 'file',
    () => false,
  )
  if (!isThere) {
    $.ui.toast(`${splitPath(file.path).name} is not in the working tree anymore.`)
    return
  }
  await openInCode($, root, file.path)
}

async function openInCode($: EngineInterface, root: string, path: string): Promise<void> {
  await launch($, splitPath(path).name, openCommand(`${root}/${path}`, root))
}

async function launch($: EngineInterface, name: string, { argv, init }: ReturnType<typeof openCommand>): Promise<void> {
  try {
    const run = await $.process.run(argv, init)
    if (run.exitCode !== 0) $.ui.toast(`Could not open ${name} in VS Code: ${firstLine(run.stderr) || `systemd-run exited ${run.exitCode}`}`)
  } catch (err) {
    $.ui.toast(`Could not open ${name} in VS Code: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function targetPath(target: DiffTarget): string {
  return target.kind === 'change' ? target.change.path : target.file.path
}

/** VS Code's diff titles: the file, then which side of it the diff shows. */
function diffTitle(target: DiffTarget): string {
  const { name } = splitPath(targetPath(target))
  if (target.kind === 'commit') return `${name} (${target.commit.hash.slice(0, 7)})`
  return `${name} (${target.change.group === 'staged' ? 'Index' : 'Working Tree'})`
}

async function readDiff($: EngineInterface, target: DiffTarget): Promise<Pick<Diff, 'source' | 'size' | 'note'>> {
  const args = target.kind === 'change' ? changeDiffArgs(target.change) : commitDiffArgs(target.commit, target.file)
  try {
    const run = await git($, target.root, { args })
    if (run.exitCode !== 0 && !(run.exitCode === 1 && args.includes('--no-index'))) {
      return { note: `Could not read the diff: ${firstLine(run.stderr) || `git exited ${run.exitCode}`}` }
    }
    const source = diffHunks(run.stdout)
    if (run.isStdoutTruncated || source.length > MAX_DIFF) return { size: source.length }
    return source ? { source } : { note: 'No changes to show.' }
  } catch (err) {
    return { note: `Could not read the diff: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** Reads `target`'s diff into the pane, unless the pane has moved to another file or closed meanwhile. */
async function fillDiff($: EngineInterface, target: DiffTarget): Promise<void> {
  const found = await readDiff($, target)
  const key = JSON.stringify(target)
  await update($, diff, view => (view && JSON.stringify(view.target) === key ? { title: view.title, path: view.path, target: view.target, ...found } : view))
}

/** Opens the diff pane on `target` in front of Source Control, then fills it when git answers. */
async function showDiff($: EngineInterface, target: DiffTarget): Promise<void> {
  const title = diffTitle(target)
  await update($, diff, () => ({ title, path: targetPath(target), target }))
  // Panes show one at a time, the rest tabs; `focus` brings this one forward, where the surface allows it.
  const opened = await $.ui.open({ id: DIFF_PANE, title, focus: true })
  if (!opened.isPlaced) $.ui.toast(`The diff pane is not shown: ${opened.reason}`)
  else if (!(await $.ui.panes()).some(pane => pane.id === DIFF_PANE && pane.isShown)) $.ui.toast(`${title} is open in its own tab, behind Source Control.`)
  await fillDiff($, target)
}

/** A side as a file VS Code can open: the working tree's own, else a copy written under `dir`. */
async function sideFile($: EngineInterface, root: string, dir: string, side: Side): Promise<string> {
  if (side.kind === 'worktree') return `${root}/${side.path}`
  const file = `${dir}/${side.kind === 'empty' ? 'empty' : side.rev.slice(0, 7) || 'index'}/${side.path}`
  let text = ''
  if (side.kind === 'blob') {
    const run = await git($, root, { args: ['cat-file', 'blob', `${side.rev}:${side.path}`] })
    if (run.exitCode !== 0) throw new Error(firstLine(run.stderr) || `git exited ${run.exitCode}`)
    text = run.stdout
  }
  await $.fs.write(file, text)
  return file
}

let diffsInCode = false // userConfig.diff_view: `vscode` opens diffs in VS Code instead of the pane

async function viewDiff($: EngineInterface, target: DiffTarget): Promise<void> {
  try {
    await (diffsInCode ? openDiffInCode($, target) : showDiff($, target))
  } catch (err) {
    $.ui.toast(`Could not show the diff of ${splitPath(targetPath(target)).name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Opens `target` in VS Code's diff editor, as its Source Control does; an untracked or conflicted file opens as it is. */
async function openDiffInCode($: EngineInterface, target: DiffTarget): Promise<void> {
  const path = targetPath(target)
  const sides = target.kind === 'change' ? changeSides(target.change) : commitSides(target.commit, target.file)
  if (!sides) return openInCode($, target.root, path)
  const { name } = splitPath(path)
  let left: string
  let right: string
  try {
    const tmp = (await $.env.get('XDG_RUNTIME_DIR').catch(() => undefined)) || '/tmp'
    const dir = `${tmp}/source-control-diff/${splitPath(target.root).name}`
    left = await sideFile($, target.root, dir, sides[0])
    right = await sideFile($, target.root, dir, sides[1])
  } catch (err) {
    $.ui.toast(`Could not open the diff of ${name}: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  await launch($, name, diffCommand(left, right, target.root))
}

async function commit($: EngineInterface, text: string, stageAll = false): Promise<void> {
  const repo = (await read($, scm)).repo
  if (!repo) return
  if (!text.trim()) {
    $.ui.toast('Type a commit message first.')
    return
  }
  if (!stageAll && !repo.changes.some(c => c.group === 'staged')) {
    if (repo.changes.some(c => c.group === 'merge')) $.ui.toast('Stage the resolved merge changes first.')
    else if (!repo.changes.length) $.ui.toast('There are no changes to commit.')
    else await update($, confirm, () => ({ kind: 'commit-all' }))
    return
  }
  await update($, confirm, () => null)
  const runs: Run[] = [...(stageAll ? [{ args: ['add', '-A'] }] : []), { args: ['commit', '--quiet', '-F', '-'], stdin: text }]
  if (await act($, 'Commit', repo.root, runs)) {
    await update($, draft, () => '')
    await update($, field, n => n + 1)
  }
}

/** Expands or folds a commit in the graph, reading its files the first time. */
async function toggleCommit($: EngineInterface, root: string, commit: Commit): Promise<void> {
  if ((await read($, expanded)).includes(commit.hash)) {
    await update($, expanded, list => list.filter(hash => hash !== commit.hash))
    return
  }
  await update($, expanded, list => [...list, commit.hash])
  if ((await read($, files))[commit.hash]) return
  let list: CommitFile[] = []
  try {
    const run = await git($, root, { args: commitFilesArgs(commit) })
    if (run.exitCode === 0) list = parseNameStatus(run.stdout)
    else $.ui.toast(`Could not list the files of ${commit.hash.slice(0, 7)}: ${firstLine(run.stderr) || `git exited ${run.exitCode}`}`)
  } catch (err) {
    $.ui.toast(`Could not list the files of ${commit.hash.slice(0, 7)}: ${err instanceof Error ? err.message : String(err)}`)
  }
  await update($, files, all => Object.fromEntries([...Object.entries(all).filter(([hash]) => hash !== commit.hash), [commit.hash, list]].slice(-MAX_CACHED)))
}

function touchesRepo(e: { tool: string; command?: unknown }): boolean {
  if (EDITS.has(e.tool)) return true
  return e.tool === 'Bash' && typeof e.command === 'string' && /\bgit\b/.test(e.command)
}

async function show($: EngineInterface): Promise<void> {
  await refresh($)
  if ((await read($, scm)).repo) await $.ui.open({ id: PANE, title: TITLE })
}

export const register: Register = (on, options) => {
  diffsInCode = options.diff_view === 'vscode'

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'scm', description: 'Open the Source Control pane' })
    $.clock.after(0, () => void show($))
    return next(e)
  })

  on('command.run', { command: 'scm' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Source Control pane opened.' }
  })

  // It only watches: a failure here must never change what the tool call settled to.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (touchesRepo({ tool: String(e.tool), command: 'command' in e ? e.command : undefined })) schedule($)
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', ($, e, next) => {
    schedule($)
    return next(e)
  })

  // A closed diff pane stops following the repo until a file is clicked again; it only watches the close.
  on('ui.close', { id: DIFF_PANE }, async ($, e, next) => {
    await update($, diff, () => null)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: DIFF_PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const view = await read($, diff)
    if (view?.size !== undefined) {
      return (
        <Box flexDirection="column" paddingX={1} gap={1}>
          <Text dimColor>{`This diff is too large to show here (${Math.round(view.size / 1_000)}k characters).`}</Text>
          <Box flexDirection="row">
            <Button key="diff-in-code" label="Open in VS Code" onPress={() => void openDiffInCode($, view.target)} />
          </Box>
        </Box>
      )
    }
    if (view?.source === undefined) {
      return (
        <Box paddingX={1}>
          <Text dimColor>{view ? (view.note ?? 'Loading') : 'Click a changed file to see its diff.'}</Text>
        </Box>
      )
    }
    // A diff with no hunks (binary, a pure rename) is git's own words, drawn as they are.
    return /^@@ /m.test(view.source) ? <Code source={view.source} format="diff" path={view.path} /> : <Code source={view.source} />
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = $.ui.resolve(e)
    const { Box, Text, Button } = t
    // Picked by surface, not by the table: a surface's table may stand in for what it cannot draw.
    const Svg = e.surface === 'terminal' ? undefined : $.ui.resolve(e).Svg
    const Input = e.surface === 'mobile' ? undefined : $.ui.resolve(e).Input
    // The terminal shows row actions all the time; a pointer surface reveals them on hover, as VS Code does.
    const canHover = e.surface !== 'terminal'
    const { repo, error } = await read($, scm)
    const shut = new Set(await read($, collapsed))
    const ask = await read($, confirm)
    const working = await read($, busy)

    if (!repo) {
      return (
        <Box flexDirection="column" paddingX={1} gap={1}>
          <Text dimColor>{error || 'Reading the repository...'}</Text>
          <Box flexDirection="row">
            <Button key="retry" label="Refresh" onPress={() => void refresh($)} />
          </Box>
        </Box>
      )
    }

    const open = new Set(await read($, expanded))
    const cached = await read($, files)
    // A pointer surface shows the vscode-icons SVG VS Code shows; the terminal, and a file whose icon is not found, keep the letter.
    const svgs = Svg
      ? await fileSvgs($, [...repo.changes, ...[...open].flatMap(hash => cached[hash] ?? [])].map(f => splitPath(f.path).name))
      : new Map<string, string>()
    const svgIcon = (key: string, name: string) => {
      const svg = svgs.get(name)
      return Svg && svg ? (
        <Box key={key} flexShrink={0} marginRight={0}>
          <Svg source={svg} alt={fileIcon(name).glyph} width={ICON_SIZE} height={ICON_SIZE} />
        </Box>
      ) : null
    }
    const letterIcon = (name: string) => {
      if (svgs.has(name)) return ''
      const look = fileIcon(name)
      return <Text color={look.color} mono>{look.glyph.padEnd(3)}</Text>
    }

    const toggle = (id: string) => void update($, collapsed, list => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]))
    const cancel = () => void update($, confirm, () => null)
    const ask$ = (next: Confirm) => void update($, confirm, () => next)
    const icon = (key: string, glyph: string, onPress: () => void) => <Button key={key} plain label={glyph} onPress={onPress} />
    const reveal = (actions: RenderElement[]) =>
      canHover ? (
        <Box flexDirection="row" flexShrink={0} gap={1} marginRight={1} display="none" hover={{ display: 'flex' }}>
          {actions}
        </Box>
      ) : (
        <Box flexDirection="row" flexShrink={0} gap={1} marginRight={1}>
          {actions}
        </Box>
      )
    const badge = (count: number) => (
      <Box flexShrink={0}>
        <Text backgroundColor={BADGE_BG} color={BADGE_FG}>{` ${count} `}</Text>
      </Box>
    )
    const header = (id: string, title: string, actions: RenderElement[], count: number | null, strong = false, extra?: RenderElement) => (
      <Box key={`head:${id}`} flexDirection="row" hover={{ backgroundColor: HOVER_BG }}>
        <Box flexGrow={1} flexShrink={1} overflow="hidden" flexDirection="row" gap={1}>
          <Button key={`toggle:${id}`} plain onPress={() => toggle(id)}>
            <Text dimColor>{shut.has(id) ? '▸' : '▾'}</Text> <Text weight={strong ? 'bold' : 'regular'}>{title}</Text>
          </Button>
          {extra ?? null}
        </Box>
        {reveal(actions)}
        {count === null ? null : badge(count)}
      </Box>
    )

    const groups: { id: Group; title: string }[] = [
      { id: 'merge', title: 'Merge Changes' },
      { id: 'staged', title: 'Staged Changes' },
      { id: 'changes', title: 'Changes' },
    ]
    const of = (group: Group) => repo.changes.filter(c => c.group === group)
    const stageAll = (group: Group) =>
      void act($, 'Stage', repo.root, [{ args: group === 'merge' ? ['add', '--', ...of('merge').map(c => c.path)] : ['add', '-A'] }])
    const groupActions = (group: Group): RenderElement[] =>
      group === 'staged'
        ? [icon('unstage-all', '−', () => void act($, 'Unstage', repo.root, [{ args: unstageAllArgs(repo.hasHead) }]))]
        : group === 'merge'
          ? [icon('stage-merge', '+', () => stageAll('merge'))]
          : [icon('discard-all', '↶', () => ask$({ kind: 'discard-all' })), icon('stage-all', '+', () => stageAll('changes'))]
    // VS Code's row actions, Open File first.
    const rowActions = (c: Change, id: string): RenderElement[] => [
      icon(`openfile:${id}`, OPEN_FILE, () => void openFile($, repo.root, c)),
      ...(c.group === 'staged'
        ? [icon(`unstage:${id}`, '−', () => void act($, 'Unstage', repo.root, [{ args: unstageArgs(c, repo.hasHead) }]))]
        : c.group === 'merge'
          ? [icon(`stage:${id}`, '+', () => void act($, 'Stage', repo.root, [{ args: stageArgs(c) }]))]
          : [
              icon(`discard:${id}`, '↶', () => ask$({ kind: 'discard', path: id })),
              icon(`stage:${id}`, '+', () => void act($, 'Stage', repo.root, [{ args: stageArgs(c) }])),
            ]),
    ]

    const row = (c: Change) => {
      const id = `${c.group}:${c.path}`
      const { name, dir } = splitPath(c.path)
      const color = letterColor(c)
      if (ask?.kind === 'discard' && ask.path === id) {
        const deletes = c.letter === 'U' || Boolean(c.isNew)
        return (
          <Box key={`confirm:${id}`} flexDirection="column" paddingLeft={3} gap={1}>
            <Text color={WARN}>{deletes ? `Delete ${name}? This cannot be undone.` : `Discard changes in ${name}? This cannot be undone.`}</Text>
            <Box flexDirection="row" gap={1}>
              <Button key={`do-discard:${id}`} variant="primary" onPress={() => void update($, confirm, () => null).then(() => act($, deletes ? 'Delete' : 'Discard', repo.root, [{ args: discardArgs(c) }]))}>
                {deletes ? 'Delete File' : 'Discard File'}
              </Button>
              <Button key={`cancel:${id}`} onPress={cancel}>Cancel</Button>
            </Box>
          </Box>
        )
      }
      return (
        <Box key={`row:${id}`} flexDirection="row" alignItems="center" paddingLeft={3} hover={{ backgroundColor: HOVER_BG }}>
          {svgIcon(`icon:${id}`, name)}
          <Box flexGrow={1} flexShrink={1} overflow="hidden">
            <Button key={`open:${id}`} plain onPress={() => void viewDiff($, { kind: 'change', root: repo.root, change: c })}>
              {letterIcon(name)}
              <Text color={color} strikethrough={c.letter === 'D'}>{name}</Text>
              {dir ? ' ' : ''}
              <Text dimColor>{dir}</Text>
            </Button>
          </Box>
          {reveal(rowActions(c, id))}
          <Box flexShrink={0} width={2} justifyContent="flex-end">
            <Text color={color} weight="bold">{c.letter}</Text>
          </Box>
        </Box>
      )
    }

    const changes: RenderElement[] = []
    for (const g of groups) {
      const list = of(g.id)
      if (!list.length) continue
      changes.push(header(g.id, g.title, groupActions(g.id), list.length))
      if (g.id === 'changes' && ask?.kind === 'discard-all') {
        const files = list.length
        const removes = list.filter(c => c.isNew).length
        changes.push(
          <Box key="confirm:discard-all" flexDirection="column" paddingLeft={3} gap={1}>
            <Text color={WARN}>
              {`Discard ALL changes in ${files} ${files === 1 ? 'file' : 'files'}?${removes ? ` ${removes} new ${removes === 1 ? 'file is' : 'files are'} deleted.` : ''} This cannot be undone.`}
            </Text>
            <Box flexDirection="row" gap={1}>
              <Button key="do-discard-all" variant="primary" onPress={() => void update($, confirm, () => null).then(() => act($, 'Discard', repo.root, discardAllArgs(repo.changes).map(args => ({ args }))))}>
                {`Discard All ${files} Files`}
              </Button>
              <Button key="cancel:discard-all" onPress={cancel}>Cancel</Button>
            </Box>
          </Box>,
        )
      }
      if (shut.has(g.id)) continue
      changes.push(...list.slice(0, MAX_ROWS).map(row))
      if (list.length > MAX_ROWS) changes.push(<Box paddingLeft={3}><Text dimColor>{`and ${list.length - MAX_ROWS} more`}</Text></Box>)
    }

    const where = repo.isDetached ? 'detached HEAD' : repo.branch || 'HEAD'
    const sync = [repo.ahead ? `↑${repo.ahead}` : '', repo.behind ? `↓${repo.behind}` : ''].filter(Boolean).join(' ')
    const branchInfo = (
      <Text dimColor wrap="truncate-end">
        {`⑂ ${where}${sync ? ` ${sync}` : ''}${working ? `  ${working}...` : ''}`}
      </Text>
    )
    const commitBox = Input ? (
      <Box key="commit-box" flexDirection="column" paddingX={1} gap={1}>
        <Input
          key={`message:${await read($, field)}`}
          placeholder={`Message (Enter to commit on "${where}")`}
          value={await read($, draft)}
          submitLabel="✓ Commit"
          onInput={value => void update($, draft, () => value)}
          onSubmit={value => void commit($, value)}
        />
        {ask?.kind === 'commit-all' ? (
          <Box flexDirection="column" gap={1}>
            <Text color={WARN}>There are no staged changes to commit. Stage all your changes and commit them directly?</Text>
            <Box flexDirection="row" gap={1}>
              <Button key="do-commit-all" variant="primary" onPress={() => void read($, draft).then(text => commit($, text, true))}>
                Yes
              </Button>
              <Button key="cancel:commit-all" onPress={cancel}>Cancel</Button>
            </Box>
          </Box>
        ) : null}
      </Box>
    ) : null

    const refreshIcon = (key: string) => icon(key, '↻', () => void refresh($))
    const top = header(
      'scm',
      'CHANGES',
      [icon('commit-icon', '✓', () => void read($, draft).then(text => commit($, text))), refreshIcon('refresh')],
      repo.changes.length,
      true,
      branchInfo,
    )

    // VS Code's graph labels only the refs it colors: the current branch and its upstream.
    // A surface with Svg draws VS Code's rounded pill; the terminal a colored run of text.
    const pill = (label: string, color: string) => {
      if (Svg) {
        const drawn = pillSvg(label, color)
        return <Svg source={drawn.source} alt={label} width={drawn.width} height={drawn.height} />
      }
      const text = ` ${label} `
      return (
        <Box flexShrink={0} width={Math.min(text.length, 24)} overflow="hidden">
          <Text backgroundColor={color} color="#FFFFFF" wrap="truncate-end">{text}</Text>
        </Box>
      )
    }
    const badges = (c: Commit) => {
      const head = c.refs.find(ref => ref.kind === 'head')
      const remote = c.refs.find(ref => ref.kind === 'remote' && ref.name === repo.upstream)
      if (!head && !remote) return null
      return (
        <Box flexDirection="row" flexShrink={0} gap={Svg ? 'xs' : 1} marginLeft={1}>
          {head ? pill(head.name, REF_COLOR) : null}
          {remote ? pill(head ? '☁' : `☁ ${remote.name}`, REMOTE_COLOR) : null}
        </Box>
      )
    }
    // A commit's files, one row each, under it; `lead` draws the lanes running past them.
    const commitFiles = (c: Commit, lead: () => RenderElement) => {
      const list = cached[c.hash]
      if (!list) return [<Box key={`cload:${c.hash}`} flexDirection="row">{lead()}<Text dimColor>Loading</Text></Box>]
      if (!list.length) return [<Box key={`cnone:${c.hash}`} flexDirection="row">{lead()}<Text dimColor>No changes</Text></Box>]
      const rows = list.slice(0, MAX_ROWS).map(f => {
        const { name, dir } = splitPath(f.path)
        return (
          <Box key={`cfile:${c.hash}:${f.path}`} flexDirection="row" alignItems="center" hover={{ backgroundColor: HOVER_BG }}>
            {lead()}
            {svgIcon(`cicon:${c.hash}:${f.path}`, name)}
            <Box flexGrow={1} flexShrink={1} overflow="hidden">
              <Button key={`copen:${c.hash}:${f.path}`} plain onPress={() => void viewDiff($, { kind: 'commit', root: repo.root, commit: { hash: c.hash, parents: c.parents }, file: f })}>
                {letterIcon(name)}
                <Text strikethrough={f.letter === 'D'}>{name}</Text>
                {dir ? ' ' : ''}
                <Text dimColor>{dir}</Text>
              </Button>
            </Box>
            {reveal([icon(`copenfile:${c.hash}:${f.path}`, OPEN_FILE, () => void openCommitFile($, repo.root, f))])}
            <Box flexShrink={0} width={2} justifyContent="flex-end">
              <Text color={letterColor({ path: f.path, letter: f.letter, group: 'changes' })} weight="bold">{f.letter}</Text>
            </Box>
          </Box>
        )
      })
      if (list.length > MAX_ROWS) rows.push(<Box flexDirection="row">{lead()}<Text dimColor>{`and ${list.length - MAX_ROWS} more`}</Text></Box>)
      return rows
    }
    const subjectButton = (c: Commit) => (
      <Box flexGrow={1} flexShrink={1} overflow="hidden" minWidth={8}>
        <Button key={`commit:${c.hash}`} plain onPress={() => void toggleCommit($, repo.root, c)}>
          <Text>{c.subject}</Text>  <Text dimColor>{c.author}</Text>
        </Button>
      </Box>
    )
    const nodes = Svg ? layout(repo.commits, repo.upstream) : []
    const graph: RenderElement[] = []
    if (!shut.has('graph')) {
      if (!repo.commits.length) graph.push(<Box paddingLeft={3}><Text dimColor>No commits yet.</Text></Box>)
      else if (Svg) {
        repo.commits.forEach((c, i) => {
          const node = nodes[i]
          if (!node) return
          const isOpen = open.has(c.hash)
          graph.push(
            <Box
              key={`crow:${c.hash}`}
              flexDirection="row"
              alignItems="center"
              paddingLeft={1}
              hover={{ backgroundColor: isOpen ? SELECTED_BG : HOVER_BG }}
              {...(isOpen ? { backgroundColor: SELECTED_BG } : {})}
            >
              <Svg source={rowSvg(c, node)} alt={`commit ${c.hash.slice(0, 7)}`} width={graphWidth(node)} height={ROW_HEIGHT} />
              {subjectButton(c)}
              {badges(c)}
            </Box>,
          )
          if (isOpen) {
            const lanes = passSvg(node)
            graph.push(
              ...commitFiles(c, () => (
                <Box flexShrink={0} paddingLeft={1} marginRight={2}>
                  <Svg source={lanes} alt="" width={graphWidth(node)} height={ROW_HEIGHT} />
                </Box>
              )),
            )
          }
        })
      } else {
        repo.rows.forEach((r, i) => {
          const c = r.commit >= 0 ? repo.commits[r.commit] : undefined
          graph.push(
            <Box key={`line:${i}`} flexDirection="row" paddingLeft={1}>
              <Box flexShrink={0}>
                <Text>
                  {textGraph(r.graph, c?.refs.some(ref => ref.kind === 'head') ?? false).map(run => (
                    <Text color={run.color}>{run.text}</Text>
                  ))}
                </Text>
              </Box>
              {c ? <Box marginLeft={1} flexGrow={1} flexShrink={1} overflow="hidden">{subjectButton(c)}</Box> : null}
              {c ? badges(c) : null}
            </Box>,
          )
          if (c && open.has(c.hash)) {
            const through = textGraph(r.graph.replace('*', '|'))
            graph.push(
              ...commitFiles(c, () => (
                <Box flexShrink={0} paddingLeft={1} marginRight={2}>
                  <Text>
                    {through.map(run => (
                      <Text color={run.color}>{run.text}</Text>
                    ))}
                  </Text>
                </Box>
              )),
            )
          }
        })
      }
      if (repo.commits.length >= (await read($, limit))) {
        graph.push(
          <Box paddingLeft={3}>
            <Button key="more" plain dimColor onPress={() => void update($, limit, n => n + PAGE).then(() => refresh($))}>
              Load More
            </Button>
          </Box>,
        )
      }
    }

    return (
      <Box flexDirection="column">
        {top}
        {shut.has('scm') ? null : commitBox}
        {shut.has('scm') ? null : changes}
        <Box marginTop={1} flexDirection="column">
          {header('graph', 'GRAPH', [refreshIcon('refresh-graph')], null, true)}
          {graph}
        </Box>
      </Box>
    )
  })
}
