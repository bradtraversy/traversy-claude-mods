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

type Call = { argv: string[]; stdin?: string; cwd?: string }

function fakeRepo(on: On, openExit = 0, missing: string[] = []) {
  const calls: Call[] = []
  const toasts: string[] = []
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.stat', (_, e) => (missing.includes(e.path) ? { deny: 'ENOENT' } : { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    calls.push({ argv, ...(e.init?.stdin === undefined ? {} : { stdin: e.init.stdin }), ...(e.init?.cwd === undefined ? {} : { cwd: e.init.cwd }) })
    const done = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'sh') return done(openExit)
    if (argv.includes('rev-parse')) return done(0, '/repo\n')
    if (argv.includes('status')) return done(0, STATUS)
    if (argv.includes('log')) return done(0, LOG)
    if (argv.includes('diff-tree')) return done(0, TREE)
    return done(0)
  })
  const gits = () => calls.filter(c => c.argv[0] === 'git').map(c => c.argv.slice(4))
  return { calls, toasts, gits }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`clicking a changed file opens it in VS Code, on ${surface}`, async ($, on) => {
    const repo = fakeRepo(on)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'retry' })

    expect(await ui.find({ type: 'Text', text: /Staged Changes/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /feat: second/ })).toBeDefined()
    await ui.press({ key: 'open:changes:src/changed.ts' })

    const open = repo.calls.find(c => c.argv[0] === 'sh')
    expect(open?.argv).toEqual(['sh', '-c', LINUX_LAUNCH, 'sh', 'systemd-run', '--user', '--collect', '--quiet', '--same-dir', 'code', '-g', '/repo/src/changed.ts'])
    expect(open?.cwd).toBe('/repo')
    expect(repo.toasts).toEqual([])
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
  await ui.press({ key: 'open:staged:src/staged.ts' })
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
  test(`clicking a commit lists its files, and a file opens in VS Code, on ${surface}`, async ($, on) => {
    const repo = fakeRepo(on, 0, ['/repo/src/moved.ts'])
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'retry' })
    expect(await ui.find({ key: 'copen:c2:src/changed.ts' })).toBeUndefined()

    await ui.press({ key: 'commit:c2' })
    expect(repo.gits()).toContainEqual(['diff-tree', '-r', '-z', '-M', '--name-status', 'c1', 'c2'])
    expect(await ui.find({ key: 'copen:c2:src/changed.ts' })).toBeDefined()
    expect(await ui.find({ key: 'copen:c2:removed.md' })).toBeDefined()

    await ui.press({ key: 'copen:c2:src/changed.ts' })
    expect(repo.calls.find(c => c.argv[0] === 'sh')?.argv.at(-1)).toBe('/repo/src/changed.ts')

    await ui.press({ key: 'copen:c2:src/moved.ts' })
    expect(repo.toasts).toEqual(['moved.ts is not in the working tree anymore.'])

    await ui.press({ key: 'commit:c2' })
    expect(await ui.find({ key: 'copen:c2:src/changed.ts' })).toBeUndefined()
    await ui.press({ key: 'commit:c1' })
    expect(repo.gits()).toContainEqual(['diff-tree', '--no-commit-id', '-r', '-z', '-M', '--name-status', '--root', 'c1'])
    await ui.unmount()
  })
}

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
