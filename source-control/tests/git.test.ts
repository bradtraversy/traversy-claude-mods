import { describe, expect, test } from 'claude-code/testing'

import { commitFilesArgs, discardAllArgs, discardArgs, LOG_FORMAT, parseLog, parseNameStatus, parseRefs, parseStatus, stageArgs, unstageArgs } from '../hooks/git'
import { layout, pillSvg, REF_COLOR, rowSvg } from '../hooks/graph'
import { LINUX_LAUNCH, openCommand } from '../hooks/open'

const z = (...entries: string[]) => entries.join('\0') + '\0'

describe('parseStatus', () => {
  test('sorts entries into VS Code groups', () => {
    const s = parseStatus(
      z(
        '## main...origin/main [ahead 2, behind 1]',
        'M  src/staged.ts',
        ' M src/changed.ts',
        'MM both.ts',
        'A  added.ts',
        ' D gone.md',
        'D  removed.md',
        'R  new/name.ts',
        'old/name.ts',
        '?? notes/todo.txt',
        'UU conflict.ts',
        'AA both-added.ts',
        ' A intent.ts',
        '!! ignored.log',
      ),
    )
    expect(s.branch).toBe('main')
    expect(s.upstream).toBe('origin/main')
    expect(s.ahead).toBe(2)
    expect(s.behind).toBe(1)
    expect(s.hasHead).toBe(true)
    expect(s.changes).toEqual([
      { path: 'src/staged.ts', letter: 'M', group: 'staged' },
      { path: 'src/changed.ts', letter: 'M', group: 'changes' },
      { path: 'both.ts', letter: 'M', group: 'staged' },
      { path: 'both.ts', letter: 'M', group: 'changes' },
      { path: 'added.ts', letter: 'A', group: 'staged' },
      { path: 'gone.md', letter: 'D', group: 'changes' },
      { path: 'removed.md', letter: 'D', group: 'staged' },
      { path: 'new/name.ts', letter: 'R', group: 'staged', orig: 'old/name.ts' },
      { path: 'notes/todo.txt', letter: 'U', group: 'changes', isNew: true },
      { path: 'conflict.ts', letter: '!', group: 'merge' },
      { path: 'both-added.ts', letter: '!', group: 'merge' },
      { path: 'intent.ts', letter: 'A', group: 'changes', isNew: true },
    ])
  })

  test('keeps spaces and arrows in paths whole', () => {
    const s = parseStatus(z('## main', ' M dir with space/a -> b.ts', 'R  to file.ts', 'from file.ts'))
    expect(s.changes.map(c => c.path)).toEqual(['dir with space/a -> b.ts', 'to file.ts'])
    expect(s.changes[1]?.orig).toBe('from file.ts')
  })

  test('reads an unborn branch, a detached HEAD, and a gone upstream', () => {
    expect(parseStatus(z('## No commits yet on main', '?? a.txt'))).toMatchObject({ branch: 'main', hasHead: false })
    expect(parseStatus(z('## HEAD (no branch)'))).toMatchObject({ branch: '', isDetached: true })
    expect(parseStatus(z('## topic...origin/topic [gone]'))).toMatchObject({ branch: 'topic', upstream: '', ahead: 0 })
    expect(parseStatus(z('## feature/x'))).toMatchObject({ branch: 'feature/x', upstream: '' })
  })
})

describe('row actions', () => {
  test('stage, unstage and discard run the git VS Code runs', () => {
    expect(stageArgs({ path: 'a.ts', letter: 'M', group: 'changes' })).toEqual(['add', '-A', '--', 'a.ts'])
    expect(unstageArgs({ path: 'n.ts', orig: 'o.ts', letter: 'R', group: 'staged' }, true)).toEqual(['restore', '--staged', '--', 'n.ts', 'o.ts'])
    expect(unstageArgs({ path: 'a.ts', letter: 'A', group: 'staged' }, false)).toEqual(['rm', '--cached', '-r', '-q', '--', 'a.ts'])
    expect(discardArgs({ path: 'a.ts', letter: 'M', group: 'changes' })).toEqual(['restore', '--worktree', '--', 'a.ts'])
    expect(discardArgs({ path: 'new.txt', letter: 'U', group: 'changes', isNew: true })).toEqual(['clean', '-f', '-q', '--', 'new.txt'])
    expect(discardArgs({ path: 'i.ts', letter: 'A', group: 'changes', isNew: true })).toEqual(['rm', '-f', '-q', '--', 'i.ts'])
  })

  test('discard all leaves staged files alone', () => {
    const runs = discardAllArgs([
      { path: 's.ts', letter: 'M', group: 'staged' },
      { path: 'm.ts', letter: 'M', group: 'changes' },
      { path: 'u.txt', letter: 'U', group: 'changes', isNew: true },
    ])
    expect(runs).toEqual([
      ['restore', '--worktree', '--', 'm.ts'],
      ['clean', '-f', '-q', '--', 'u.txt'],
    ])
  })
})

describe('parseLog', () => {
  const rec = (hash: string, parents: string, refs: string, subject: string) =>
    `\x01${hash}\x02${parents}\x02Brad Traversy\x022 days ago\x02${refs}\x02${subject}`

  test('reads commits, refs and the text graph', () => {
    const out = [
      `* ${rec('c3', 'c2 b1', 'HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD', 'Merge branch topic')}`,
      '|\\',
      `| * ${rec('b1', 'c1', 'tag: refs/tags/v1.0', 'topic work')}`,
      `* | ${rec('c2', 'c1', '', 'main work')}`,
      '|/',
      `* ${rec('c1', '', '', 'first')}`,
    ].join('\n')
    const { commits, rows } = parseLog(out)
    expect(commits.map(c => c.hash)).toEqual(['c3', 'b1', 'c2', 'c1'])
    expect(commits[0]?.parents).toEqual(['c2', 'b1'])
    expect(commits[0]?.refs).toEqual([
      { name: 'main', kind: 'head' },
      { name: 'origin/main', kind: 'remote' },
    ])
    expect(commits[1]?.refs).toEqual([{ name: 'v1.0', kind: 'tag' }])
    expect(commits[3]?.parents).toEqual([])
    expect(rows.map(r => r.commit)).toEqual([0, -1, 1, 2, -1, 3])
    expect(rows[1]?.graph).toBe('|\\')

    const nodes = layout(commits, 'origin/main')
    expect(nodes[0]?.output.map(l => l.id)).toEqual(['c2', 'b1'])
    expect(nodes[1]?.input.map(l => l.id)).toEqual(['c2', 'b1'])
    expect(nodes[3]?.input.map(l => l.id)).toEqual(['c1', 'c1'])
    const svg = rowSvg(commits[0]!, nodes[0]!)
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('<circle')
  })

  test('the format separates fields with control characters', () => {
    expect(LOG_FORMAT).toBe('%x01%H%x02%P%x02%an%x02%ar%x02%D%x02%s')
    expect(parseRefs('HEAD')).toEqual([{ name: 'HEAD', kind: 'head' }])
    expect(parseRefs('refs/heads/feature/x, refs/stash')).toEqual([{ name: 'feature/x', kind: 'branch' }])
  })
})

describe('commit files', () => {
  test('a commit lists against its first parent, a root commit against nothing', () => {
    const commit = { hash: 'm', parents: ['p1', 'p2'], author: '', date: '', refs: [], subject: '' }
    expect(commitFilesArgs(commit)).toEqual(['diff-tree', '-r', '-z', '-M', '--name-status', 'p1', 'm'])
    expect(commitFilesArgs({ ...commit, parents: [] })).toEqual(['diff-tree', '--no-commit-id', '-r', '-z', '-M', '--name-status', '--root', 'm'])
  })

  test('reads name-status with renames', () => {
    expect(parseNameStatus(['A', 'new.ts', 'R087', 'a/old.ts', 'a/new name.ts', 'D', 'gone.md', 'T', 'link'].join('\0') + '\0')).toEqual([
      { path: 'new.ts', letter: 'A' },
      { path: 'a/new name.ts', orig: 'a/old.ts', letter: 'R' },
      { path: 'gone.md', letter: 'D' },
      { path: 'link', letter: 'T' },
    ])
  })
})

describe('openCommand', () => {
  test('opens through systemd-run inside filetree\'s detached launch', () => {
    const { argv, init } = openCommand('/repo/src/a file.ts', '/repo')
    expect(argv).toEqual([
      'sh', '-c', LINUX_LAUNCH, 'sh',
      'systemd-run', '--user', '--collect', '--quiet', '--same-dir', 'code', '-g', '/repo/src/a file.ts',
    ])
    expect(init).toEqual({ cwd: '/repo', timeoutMs: 10_000 })
    expect(LINUX_LAUNCH).toBe('setsid -f -w "$@" </dev/null >/dev/null 2>&1 & p=$!; sleep 1; kill -0 "$p" 2>/dev/null && exit 0; wait "$p"')
  })
})

describe('pillSvg', () => {
  test('a ref label is a fully rounded pill sized to its text, the text escaped and capped', () => {
    const short = pillSvg('main', REF_COLOR)
    expect(short.height).toBe(18)
    expect(short.source).toContain(`<rect width="${short.width}" height="18" rx="9" fill="${REF_COLOR}"/>`)
    expect(short.source).toContain('>main</text>')
    expect(pillSvg('feature/a-much-longer-branch', REF_COLOR).width).toBeGreaterThan(short.width)
    expect(pillSvg('a&b<c', REF_COLOR).source).toContain('>a&#38;b&#60;c</text>')
    expect(pillSvg('x'.repeat(40), REF_COLOR).source).toContain(`>${'x'.repeat(21)}...</text>`)
  })
})
