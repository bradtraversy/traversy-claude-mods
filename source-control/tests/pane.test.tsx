import { expect, mock, test } from 'claude-code/testing'
import type { FoundElement } from 'claude-code/testing'
import type { On } from 'claude-code'

import { REF_COLOR, REMOTE_COLOR } from '../hooks/graph'
import { LINUX_LAUNCH } from '../hooks/open'

const PANE = {
  plugin: 'source-control',
  component: 'Pane',
  requestId: 'source-control',
  props: {
    title: 'Source Control',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const STATUS = ['## main...origin/main [ahead 1]', 'M  src/staged.ts', ' M src/changed.ts', '?? notes.txt'].join('\0') + '\0'
const LOG = [
  '* \x01c2\x02c1\x02Brad Traversy\x02now\x02HEAD -> refs/heads/main, tag: refs/tags/v2\x02feat: second',
  '* \x01c1\x02\x02Brad Traversy\x02yesterday\x02refs/remotes/origin/main, refs/heads/old\x02feat: first',
].join('\n')
const TREE = ['M', 'src/changed.ts', 'R100', 'old/gone.ts', 'src/moved.ts', 'D', 'removed.md'].join('\0') + '\0'
const HUNK = ['@@ -1 +1 @@', '-old', '+new'].join('\n')
const DIFF = ['diff --git a/x b/x', 'index 1..2 100644', '--- a/x', '+++ b/x', HUNK, ''].join('\n')

type Call = { argv: string[]; stdin?: string; cwd?: string }

/** A repo whose `status` and `diff` a test may change before the pane reads them again. */
function fakeRepo(on: On, openExit = 0, missing: string[] = []) {
  const calls: Call[] = []
  const toasts: string[] = []
  const opens: { id: string; title?: string; focus?: true }[] = []
  const writes: { path: string; text: string }[] = []
  const repo = { calls, toasts, opens, writes, status: STATUS, diff: DIFF, isShown: true, openDeny: '', gits: () => calls.filter(c => c.argv[0] === 'git').map(c => c.argv.slice(4)) }
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.stat', (_, e) => (missing.includes(e.path) ? { deny: 'ENOENT' } : { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }))
  on('fs.write', (_, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_, e) => {
    if (repo.openDeny) return { deny: repo.openDeny }
    opens.push({ id: e.id, ...(e.title === undefined ? {} : { title: e.title }), ...(e.focus ? { focus: e.focus } : {}) })
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({
    value: opens.map(open => ({ id: open.id, title: open.title ?? open.id, isShown: repo.isShown, isFocused: repo.isShown, isPlaced: true })),
  }))
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    calls.push({ argv, ...(e.init?.stdin === undefined ? {} : { stdin: e.init.stdin }), ...(e.init?.cwd === undefined ? {} : { cwd: e.init.cwd }) })
    const done = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'sh') return done(openExit)
    if (argv.includes('rev-parse')) return done(0, '/repo\n')
    if (argv.includes('cat-file')) return done(0, `blob ${argv.at(-1)}\n`)
    if (argv.includes('diff') || argv.includes('-p')) return done(argv.includes('--no-index') ? 1 : 0, repo.diff)
    if (argv.includes('status')) return done(0, repo.status)
    if (argv.includes('log')) return done(0, LOG)
    if (argv.includes('diff-tree')) return done(0, TREE)
    return done(0)
  })
  return repo
}

const DIFF_PANE = { ...PANE, requestId: 'source-control-diff', props: { ...PANE.props, title: 'Diff' } } as const
const CODE_WITH = ['systemd-run', '--user', '--collect', '--quiet', '--same-dir', 'code']
const noRemote = (gits: string[][]) => !gits.some(a => a[0] === 'push' || a[0] === 'pull' || a[0] === 'fetch')

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a changed file's open icon opens it in VS Code, on ${surface}`, async ($, on) => {
    const repo = fakeRepo(on)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'retry' })

    expect(await ui.find({ type: 'Text', text: /Staged Changes/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /feat: second/ })).toBeDefined()
    await ui.press({ key: 'openfile:changes:src/changed.ts' })

    const open = repo.calls.find(c => c.argv[0] === 'sh')
    expect(open?.argv).toEqual(['sh', '-c', LINUX_LAUNCH, 'sh', 'systemd-run', '--user', '--collect', '--quiet', '--same-dir', 'code', '-g', '/repo/src/changed.ts'])
    expect(open?.cwd).toBe('/repo')
    expect(repo.toasts).toEqual([])
    expect(repo.opens).toEqual([])
    await ui.unmount()
  })

  test(`discard asks first, on ${surface}`, async ($, on) => {
    const repo = fakeRepo(on)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'retry' })

    await ui.press({ key: 'discard:changes:src/changed.ts' })
    expect(repo.gits().some(a => a[0] === 'restore')).toBe(false)
    expect(await ui.find({ type: 'Text', text: /Discard changes in changed\.ts\?/ })).toBeDefined()

    await ui.press({ key: 'cancel:changes:src/changed.ts' })
    expect(await ui.find({ key: 'do-discard:changes:src/changed.ts' })).toBeUndefined()

    await ui.press({ key: 'discard:changes:notes.txt' })
    expect(await ui.find({ type: 'Text', text: /Delete notes\.txt\?/ })).toBeDefined()
    await ui.press({ key: 'do-discard:changes:notes.txt' })
    expect(repo.gits()).toContainEqual(['clean', '-f', '-q', '--', 'notes.txt'])
    await ui.unmount()
  })

  test(`stage, unstage and commit, on ${surface}`, async ($, on) => {
    const repo = fakeRepo(on)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'retry' })

    await ui.press({ key: 'stage:changes:src/changed.ts' })
    expect(repo.gits()).toContainEqual(['add', '-A', '--', 'src/changed.ts'])
    await ui.press({ key: 'unstage:staged:src/staged.ts' })
    expect(repo.gits()).toContainEqual(['restore', '--staged', '--', 'src/staged.ts'])

    await ui.input({ key: 'message:0', text: 'fix: the thing' })
    const commit = repo.calls.find(c => c.argv.includes('commit'))
    expect(commit?.argv.slice(4)).toEqual(['commit', '--quiet', '-F', '-'])
    expect(commit?.stdin).toBe('fix: the thing')
    expect(await ui.find({ key: 'message:1' })).toBeDefined()
    expect(repo.gits().some(a => a[0] === 'push' || a[0] === 'pull' || a[0] === 'fetch')).toBe(false)
    await ui.unmount()
  })
}

test('a failed open says why in a toast', async ($, on) => {
  const repo = fakeRepo(on, 1)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'retry' })
  await ui.press({ key: 'openfile:staged:src/staged.ts' })
  expect(repo.toasts).toEqual(['Could not open staged.ts in VS Code: systemd-run exited 1'])
  await ui.unmount()
})

test('the desktop draws the graph as Svg, the terminal as text', async ($, on) => {
  fakeRepo(on)
  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await desktop.press({ key: 'retry' })
  expect((await desktop.findAll({ type: 'Svg' })).filter(svg => /^commit /.test(String(svg.props.alt)))).toHaveLength(2)
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await terminal.find({ type: 'Text', text: '◉' })).toBeDefined()
  await terminal.unmount()
})

test('an Edit, a Write or a git command reads the repo again', async ($, on) => {
  const clock = mock.clock(on)
  const repo = fakeRepo(on)
  on('tool.call', () => ({ result: {} }))
  const reads = () => repo.gits().filter(a => a[0] === 'status').length

  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.advance(1_000)
  expect(reads()).toBe(0)

  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' })
  await clock.advance(1_000)
  expect(reads()).toBe(1)

  await $.tool.call({ tool: 'Bash', command: 'git add -A' })
  await clock.advance(1_000)
  expect(reads()).toBe(2)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`clicking a commit lists its files, and a file's open icon opens it in VS Code, on ${surface}`, async ($, on) => {
    const repo = fakeRepo(on, 0, ['/repo/src/moved.ts'])
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'retry' })
    expect(await ui.find({ key: 'copen:c2:src/changed.ts' })).toBeUndefined()

    await ui.press({ key: 'commit:c2' })
    expect(repo.gits()).toContainEqual(['diff-tree', '-r', '-z', '-M', '--name-status', 'c1', 'c2'])
    expect(await ui.find({ key: 'copen:c2:src/changed.ts' })).toBeDefined()
    expect(await ui.find({ key: 'copen:c2:removed.md' })).toBeDefined()

    await ui.press({ key: 'copenfile:c2:src/changed.ts' })
    expect(repo.calls.find(c => c.argv[0] === 'sh')?.argv.at(-1)).toBe('/repo/src/changed.ts')

    await ui.press({ key: 'copenfile:c2:src/moved.ts' })
    expect(repo.toasts).toEqual(['moved.ts is not in the working tree anymore.'])

    await ui.press({ key: 'commit:c2' })
    expect(await ui.find({ key: 'copen:c2:src/changed.ts' })).toBeUndefined()
    await ui.press({ key: 'commit:c1' })
    expect(repo.gits()).toContainEqual(['diff-tree', '--no-commit-id', '-r', '-z', '-M', '--name-status', '--root', 'c1'])
    await ui.unmount()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`clicking a changed file shows its diff in a pane beside Source Control, on ${surface}`, { options: { diff_view: 'pane' } }, async ($, on) => {
    const repo = fakeRepo(on)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'retry' })
    await ui.press({ key: 'open:changes:src/changed.ts' })

    expect(repo.opens).toEqual([{ id: 'source-control-diff', title: 'changed.ts (Working Tree)', focus: true }])
    expect(repo.gits()).toContainEqual(['diff', '--no-color', '--no-ext-diff', '--', 'src/changed.ts'])
    const pane = await $.ui.mount({ ...DIFF_PANE, surface })
    const code = await pane.find({ type: 'Code' })
    expect(code?.props).toEqual({ source: HUNK, format: 'diff', path: 'src/changed.ts' })
    expect(repo.calls.some(c => c.argv[0] === 'sh')).toBe(false)
    expect(noRemote(repo.gits())).toBe(true)
    await pane.unmount()
    await ui.unmount()
  })

  test(`each change and commit file diffs against what VS Code compares it with, on ${surface}`, async ($, on) => {
    const repo = fakeRepo(on)
    repo.status = STATUS + 'UU both.ts\0'
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'retry' })
    const pane = await $.ui.mount({ ...DIFF_PANE, surface })
    const shows = async (key: string, title: string, args: string[]) => {
      await ui.press({ key })
      expect(repo.opens.at(-1)).toEqual({ id: 'source-control-diff', title, focus: true })
      expect(repo.gits().at(-1)).toEqual(args)
      expect((await pane.find({ type: 'Code' }))?.props.source).toBe(HUNK)
    }
    const DIFF_ARGS = ['--no-color', '--no-ext-diff']

    await shows('open:staged:src/staged.ts', 'staged.ts (Index)', ['diff', ...DIFF_ARGS, '--cached', '-M', '--', 'src/staged.ts'])
    // An untracked file's --no-index diff exits 1, which is not a failure.
    await shows('open:changes:notes.txt', 'notes.txt (Working Tree)', ['diff', ...DIFF_ARGS, '--no-index', '--', '/dev/null', 'notes.txt'])
    await shows('open:merge:both.ts', 'both.ts (Working Tree)', ['diff', ...DIFF_ARGS, '--', 'both.ts'])

    await ui.press({ key: 'commit:c2' })
    await shows('copen:c2:src/changed.ts', 'changed.ts (c2)', ['diff-tree', '-p', '-M', ...DIFF_ARGS, '--no-commit-id', 'c1', 'c2', '--', 'src/changed.ts'])
    await shows('copen:c2:src/moved.ts', 'moved.ts (c2)', ['diff-tree', '-p', '-M', ...DIFF_ARGS, '--no-commit-id', 'c1', 'c2', '--', 'old/gone.ts', 'src/moved.ts'])
    await ui.press({ key: 'commit:c1' })
    await shows('copen:c1:removed.md', 'removed.md (c1)', ['diff-tree', '-p', '-M', ...DIFF_ARGS, '--no-commit-id', '--root', 'c1', '--', 'removed.md'])

    expect(repo.toasts).toEqual([])
    expect(noRemote(repo.gits())).toBe(true)
    await pane.unmount()
    await ui.unmount()
  })

  test(`a diff too large to draw offers VS Code instead, on ${surface}`, async ($, on) => {
    const repo = fakeRepo(on)
    repo.diff = `@@ -0,0 +1 @@\n+${'x'.repeat(120_000)}\n`
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'retry' })
    await ui.press({ key: 'open:changes:src/changed.ts' })

    const pane = await $.ui.mount({ ...DIFF_PANE, surface })
    expect(await pane.find({ type: 'Code' })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: 'This diff is too large to show here (120k characters).' })).toBeDefined()
    await pane.press({ key: 'diff-in-code' })
    expect(repo.calls.find(c => c.argv[0] === 'sh')?.argv.slice(4)).toEqual([...CODE_WITH, '-d', '/tmp/source-control-diff/repo/index/src/changed.ts', '/repo/src/changed.ts'])
    await pane.unmount()
    await ui.unmount()
  })

  test(`with diffs set to vscode, a click opens VS Code's diff editor and no pane, on ${surface}`, { options: { diff_view: 'vscode' } }, async ($, on) => {
    const repo = fakeRepo(on)
    mock.env(on, { XDG_RUNTIME_DIR: '/run/user/1000' })
    const tmp = '/run/user/1000/source-control-diff/repo'
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'retry' })
    const launched = () => repo.calls.filter(c => c.argv[0] === 'sh').at(-1)?.argv.slice(4)

    await ui.press({ key: 'open:changes:src/changed.ts' })
    expect(repo.gits().at(-1)).toEqual(['cat-file', 'blob', ':src/changed.ts'])
    expect(repo.writes).toEqual([{ path: `${tmp}/index/src/changed.ts`, text: 'blob :src/changed.ts\n' }])
    expect(launched()).toEqual([...CODE_WITH, '-d', `${tmp}/index/src/changed.ts`, '/repo/src/changed.ts'])

    await ui.press({ key: 'open:staged:src/staged.ts' })
    expect(launched()).toEqual([...CODE_WITH, '-d', `${tmp}/HEAD/src/staged.ts`, `${tmp}/index/src/staged.ts`])
    expect(repo.writes.at(-2)).toEqual({ path: `${tmp}/HEAD/src/staged.ts`, text: 'blob HEAD:src/staged.ts\n' })

    await ui.press({ key: 'open:changes:notes.txt' })
    expect(launched()).toEqual([...CODE_WITH, '-g', '/repo/notes.txt'])

    await ui.press({ key: 'commit:c2' })
    await ui.press({ key: 'copen:c2:removed.md' })
    expect(launched()).toEqual([...CODE_WITH, '-d', `${tmp}/c1/removed.md`, `${tmp}/empty/removed.md`])
    expect(repo.writes.at(-1)).toEqual({ path: `${tmp}/empty/removed.md`, text: '' })

    expect(repo.opens).toEqual([])
    expect(repo.gits().some(a => a[0] === 'diff' || a.includes('-p'))).toBe(false)
    expect(repo.toasts).toEqual([])
    expect(noRemote(repo.gits())).toBe(true)
    await ui.unmount()
  })
}

test('a diff the surface leaves behind Source Control says where it is', async ($, on) => {
  const repo = fakeRepo(on)
  repo.isShown = false
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'retry' })
  await ui.press({ key: 'open:staged:src/staged.ts' })
  expect(repo.toasts).toEqual(['staged.ts (Index) is open in its own tab, behind Source Control.'])
  await ui.unmount()
})

test('a diff pane that cannot open says why instead of doing nothing', async ($, on) => {
  const repo = fakeRepo(on)
  repo.openDeny = 'no room'
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'retry' })
  await ui.press({ key: 'open:changes:src/changed.ts' })
  expect(repo.toasts).toHaveLength(1)
  expect(repo.toasts[0]).toMatch(/^Could not show the diff of changed\.ts: .*no room/)
  await ui.unmount()
})

test('an open diff follows the repo, and says when there is nothing left to show', async ($, on) => {
  const repo = fakeRepo(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'retry' })
  await ui.press({ key: 'open:changes:src/changed.ts' })
  const pane = await $.ui.mount({ ...DIFF_PANE, surface: 'desktop' })

  repo.diff = ['@@ -1 +1,2 @@', '-old', '+new', '+more', ''].join('\n')
  await ui.press({ key: 'refresh' })
  expect((await pane.find({ type: 'Code' }))?.props.source).toBe(['@@ -1 +1,2 @@', '-old', '+new', '+more'].join('\n'))

  repo.diff = ''
  await ui.press({ key: 'stage:changes:src/changed.ts' })
  expect(await pane.find({ type: 'Code' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: 'No changes to show.' })).toBeDefined()
  await pane.unmount()
  await ui.unmount()
})

const EXTENSIONS = '/home/brad/.vscode/extensions'
const ICONS = `${EXTENSIONS}/vscode-icons-team.vscode-icons-13.0.0/icons`
const TS_SVG = '<svg viewBox="0 0 32 32"><title>typescript</title></svg>'
const TEXT_SVG = '<svg viewBox="0 0 32 32"><title>text</title></svg>'
const THEME = {
  file: '_file',
  iconDefinitions: {
    _file: { iconPath: '../../icons/default_file.svg' },
    _f_typescript: { iconPath: '../../icons/file_type_typescript.svg' },
    _f_text: { iconPath: '../../icons/file_type_text.svg' },
  },
  fileNames: {},
  fileExtensions: { txt: '_f_text' },
  languageIds: { typescript: '_f_typescript' },
}

/** Brad's vscode-icons install, an older copy beside it; `missing` leaves those icon files out. */
function fakeIcons(on: On, missing: string[] = []) {
  const reads: string[] = []
  mock.env(on, { HOME: '/home/brad' })
  on('fs.list', (_, e) =>
    e.path === EXTENSIONS
      ? {
          value: ['vscode-icons-team.vscode-icons-9.0.0', 'vscode-icons-team.vscode-icons-13.0.0', 'vscode-icons-team.vscode-icons-12.9.0', 'ms-python.python-2026.1.0'].map(name => ({
            name,
            kind: 'dir' as const,
            size: 0,
            mtimeMs: 0,
            isLink: false,
          })),
        }
      : { deny: 'ENOENT' },
  )
  const files: Record<string, string> = {
    [`${EXTENSIONS}/vscode-icons-team.vscode-icons-13.0.0/dist/src/vsicons-icon-theme.json`]: JSON.stringify(THEME),
    [`${ICONS}/file_type_typescript.svg`]: TS_SVG,
    [`${ICONS}/file_type_text.svg`]: TEXT_SVG,
  }
  on('fs.read', (_, e) => {
    reads.push(e.path)
    const text = files[e.path]
    return text === undefined || missing.includes(e.path) ? { deny: 'ENOENT' } : { value: text }
  })
  return { reads }
}

/** The icon a row's keyed icon box draws, if it draws one. */
const svgIn = (box: FoundElement | undefined) => box?.children.find((c): c is FoundElement => (c as FoundElement | undefined)?.type === 'Svg')

test('desktop rows draw the vscode-icons SVG beside the name, changes and commit files alike', async ($, on) => {
  fakeRepo(on)
  const icons = fakeIcons(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'retry' })

  const ts = svgIn(await ui.find({ key: 'icon:changes:src/changed.ts' }))
  expect(ts?.props.source).toBe(TS_SVG)
  expect(ts?.props.width).toBe(16)
  expect(svgIn(await ui.find({ key: 'icon:changes:notes.txt' }))?.props.source).toBe(TEXT_SVG)
  expect((await ui.find({ key: 'open:changes:src/changed.ts' }))?.text).not.toMatch(/TS/)

  await ui.press({ key: 'commit:c2' })
  expect(svgIn(await ui.find({ key: 'cicon:c2:src/changed.ts' }))?.props.source).toBe(TS_SVG)
  expect(await ui.find({ key: 'cicon:c2:removed.md' })).toBeUndefined()

  // Each file is read once, however many rows and redraws show it.
  expect(icons.reads.filter(path => path.endsWith('file_type_typescript.svg'))).toHaveLength(1)
  await ui.unmount()
})

test('a missing theme or icon file keeps the letter icons and the pane draws', async ($, on) => {
  fakeRepo(on)
  fakeIcons(on, [`${ICONS}/file_type_text.svg`])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'retry' })
  expect(svgIn(await ui.find({ key: 'icon:changes:src/changed.ts' }))?.props.source).toBe(TS_SVG)
  expect(await ui.find({ key: 'icon:changes:notes.txt' })).toBeUndefined()
  expect((await ui.find({ key: 'open:changes:notes.txt' }))?.text).toMatch(/≡/)
  await ui.unmount()
})

test('with no vscode-icons installed the desktop keeps the letter icons', async ($, on) => {
  fakeRepo(on)
  mock.env(on, { HOME: '/home/brad' })
  on('fs.list', () => ({ deny: 'ENOENT' }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'retry' })
  expect(await ui.find({ key: 'icon:changes:src/changed.ts' })).toBeUndefined()
  expect((await ui.find({ key: 'open:changes:src/changed.ts' }))?.text).toMatch(/TS/)
  expect(await ui.find({ type: 'Text', text: /Staged Changes/ })).toBeDefined()
  await ui.unmount()
})

test('the terminal keeps the letter icons and never reads the theme', async ($, on) => {
  fakeRepo(on)
  const icons = fakeIcons(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'retry' })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  expect((await ui.find({ key: 'open:changes:src/changed.ts' }))?.text).toMatch(/TS/)
  expect(icons.reads).toEqual([])
  await ui.unmount()
})

test('the graph labels only the current branch and its upstream, as VS Code does', async ($, on) => {
  fakeRepo(on)
  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await desktop.press({ key: 'retry' })
  const pills = (await desktop.findAll({ type: 'Svg' })).filter(svg => !/^commit /.test(String(svg.props.alt)))
  expect(pills.map(svg => svg.props.alt)).toEqual(['main', '☁ origin/main'])
  expect(String(pills[0]?.props.source)).toContain(`rx="9" fill="${REF_COLOR}"`)
  expect(String(pills[1]?.props.source)).toContain(`fill="${REMOTE_COLOR}"`)
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await terminal.find({ type: 'Text', text: ' main ' })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: ' ☁ origin/main ' })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: /v2|old/ })).toBeUndefined()
  await terminal.unmount()
})
