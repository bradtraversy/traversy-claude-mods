import type { Change, Commit, CommitFile, GraphRow, Letter, Ref } from '../types'

export type Status = {
  branch: string
  isDetached: boolean
  hasHead: boolean
  upstream: string
  ahead: number
  behind: number
  changes: Change[]
}

const CONFLICTS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])
const LETTERS = new Set(['M', 'A', 'D', 'R', 'C', 'T'])

/** Reads `git status --porcelain=v1 -b -z --untracked-files=all` into VS Code's three groups. */
export function parseStatus(out: string): Status {
  const status: Status = { branch: '', isDetached: false, hasHead: true, upstream: '', ahead: 0, behind: 0, changes: [] }
  const fields = out.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i] ?? ''
    if (!entry) continue
    if (entry.startsWith('## ')) {
      Object.assign(status, parseBranch(entry.slice(3)))
      continue
    }
    const x = entry[0] ?? ' '
    const y = entry[1] ?? ' '
    const path = entry.slice(3)
    const orig = x === 'R' || x === 'C' || y === 'R' || y === 'C' ? fields[++i] : undefined
    const xy = x + y
    if (xy === '!!') continue
    if (xy === '??') {
      status.changes.push({ path, letter: 'U', group: 'changes', isNew: true })
      continue
    }
    if (CONFLICTS.has(xy)) {
      status.changes.push({ path, letter: '!', group: 'merge' })
      continue
    }
    if (LETTERS.has(x)) status.changes.push({ path, letter: x as Letter, group: 'staged', ...(orig && (x === 'R' || x === 'C') ? { orig } : {}) })
    if (LETTERS.has(y)) status.changes.push({ path, letter: y as Letter, group: 'changes', ...(y === 'A' ? { isNew: true } : {}), ...(orig && (y === 'R' || y === 'C') ? { orig } : {}) })
  }
  return status
}

function parseBranch(head: string): Partial<Status> {
  const unborn = /^(?:No commits yet|Initial commit) on (.+)$/.exec(head)
  if (unborn) return { branch: unborn[1] ?? '', hasHead: false }
  if (head.startsWith('HEAD (no branch)')) return { branch: '', isDetached: true }
  const m = /^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(head)
  const track = m?.[3] ?? ''
  return {
    branch: m?.[1] ?? head,
    upstream: track === 'gone' ? '' : (m?.[2] ?? ''),
    ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
  }
}

/** The record each commit line of `git log --graph` carries after its graph prefix. */
export const LOG_FORMAT = '%x01%H%x02%P%x02%an%x02%ar%x02%D%x02%s'

/** Reads `git log --graph --decorate=full --format=LOG_FORMAT` into commits and the text graph's rows. */
export function parseLog(out: string): { commits: Commit[]; rows: GraphRow[] } {
  const commits: Commit[] = []
  const rows: GraphRow[] = []
  for (const line of out.split('\n')) {
    if (!line) continue
    const at = line.indexOf('\x01')
    if (at < 0) {
      rows.push({ graph: line.trimEnd(), commit: -1 })
      continue
    }
    const [hash = '', parents = '', author = '', date = '', refs = '', ...subject] = line.slice(at + 1).split('\x02')
    rows.push({ graph: line.slice(0, at).trimEnd(), commit: commits.length })
    commits.push({ hash, parents: parents.split(' ').filter(Boolean), author, date, refs: parseRefs(refs), subject: subject.join('\x02') })
  }
  return { commits, rows }
}

export function parseRefs(decorations: string): Ref[] {
  const refs: Ref[] = []
  for (const raw of decorations.split(', ')) {
    const item = raw.trim()
    if (!item) continue
    if (item === 'HEAD') refs.push({ name: 'HEAD', kind: 'head' })
    else if (item.startsWith('HEAD -> ')) refs.push({ name: item.slice(8).replace(/^refs\/heads\//, ''), kind: 'head' })
    else if (item.startsWith('tag: ')) refs.push({ name: item.slice(5).replace(/^refs\/tags\//, ''), kind: 'tag' })
    else if (item.startsWith('refs/remotes/')) {
      if (!item.endsWith('/HEAD')) refs.push({ name: item.slice(13), kind: 'remote' })
    } else if (item.startsWith('refs/heads/')) refs.push({ name: item.slice(11), kind: 'branch' })
    else if (item !== 'refs/stash') refs.push({ name: item, kind: 'branch' })
  }
  return refs
}

/** The files a commit changed: against its first parent, as VS Code lists a merge's, or all of a root commit's. */
export function commitFilesArgs(commit: Commit): string[] {
  const parent = commit.parents[0]
  return parent
    ? ['diff-tree', '-r', '-z', '-M', '--name-status', parent, commit.hash]
    : ['diff-tree', '--no-commit-id', '-r', '-z', '-M', '--name-status', '--root', commit.hash]
}

const DIFF = ['--no-color', '--no-ext-diff']

/** The diff VS Code shows for a change: the working tree against the index, or the index against HEAD. */
export function changeDiffArgs(change: Change): string[] {
  if (change.group === 'staged') return ['diff', ...DIFF, '--cached', '-M', '--', ...(change.orig ? [change.orig] : []), change.path]
  // --no-index exits 1 when the sides differ, which for a new file they always do.
  if (change.letter === 'U') return ['diff', ...DIFF, '--no-index', '--', '/dev/null', change.path]
  return ['diff', ...DIFF, '--', change.path]
}

/** One file of a commit against the commit's first parent, as commitFilesArgs lists it. */
export function commitDiffArgs(commit: Pick<Commit, 'hash' | 'parents'>, file: CommitFile): string[] {
  const parent = commit.parents[0]
  return ['diff-tree', '-p', '-M', ...DIFF, '--no-commit-id', ...(parent ? [parent, commit.hash] : ['--root', commit.hash]), '--', ...(file.orig ? [file.orig] : []), file.path]
}

/** A diff from its first hunk on; one with no hunks (binary, a pure rename, a mode change) stays whole. */
export function diffHunks(out: string): string {
  const at = out.search(/^@@ /m)
  return (at < 0 ? out : out.slice(at)).replace(/\n$/, '')
}

/** One side of a VS Code diff: the file in the working tree, the blob `rev:path` (`''` is the index), or an empty file. */
export type Side = { kind: 'worktree'; path: string } | { kind: 'empty'; path: string } | { kind: 'blob'; rev: string; path: string }

/** The two sides VS Code's Source Control compares for a change; none for an untracked or conflicted file, which it opens as is. */
export function changeSides(change: Change): [Side, Side] | undefined {
  if (change.letter === 'U' || change.group === 'merge') return undefined
  const old = change.orig ?? change.path
  if (change.group === 'staged') {
    return [
      change.letter === 'A' ? { kind: 'empty', path: change.path } : { kind: 'blob', rev: 'HEAD', path: old },
      change.letter === 'D' ? { kind: 'empty', path: change.path } : { kind: 'blob', rev: '', path: change.path },
    ]
  }
  return [
    change.isNew ? { kind: 'empty', path: change.path } : { kind: 'blob', rev: '', path: old },
    change.letter === 'D' ? { kind: 'empty', path: change.path } : { kind: 'worktree', path: change.path },
  ]
}

/** A commit's file before and after the commit; an added or deleted side, or a root commit's parent, is empty. */
export function commitSides(commit: Pick<Commit, 'hash' | 'parents'>, file: CommitFile): [Side, Side] {
  const parent = commit.parents[0]
  return [
    parent && file.letter !== 'A' ? { kind: 'blob', rev: parent, path: file.orig ?? file.path } : { kind: 'empty', path: file.path },
    file.letter === 'D' ? { kind: 'empty', path: file.path } : { kind: 'blob', rev: commit.hash, path: file.path },
  ]
}

/** Reads `git diff-tree -z --name-status`: a status field, then one path, or two for a rename or copy. */
export function parseNameStatus(out: string): CommitFile[] {
  const fields = out.split('\0')
  const files: CommitFile[] = []
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i]?.[0]
    if (!code) continue
    if (code === 'R' || code === 'C') {
      const orig = fields[++i] ?? ''
      files.push({ path: fields[++i] ?? '', orig, letter: code })
    } else files.push({ path: fields[++i] ?? '', letter: code === 'U' ? '!' : LETTERS.has(code) ? (code as Letter) : 'M' })
  }
  return files
}

/** What each row action runs, as git arguments after `git -C <root>`. */
export function stageArgs(change: Change): string[] {
  return ['add', '-A', '--', change.path]
}

export function unstageArgs(change: Change, hasHead: boolean): string[] {
  const paths = [change.path, ...(change.orig ? [change.orig] : [])]
  return hasHead ? ['restore', '--staged', '--', ...paths] : ['rm', '--cached', '-r', '-q', '--', ...paths]
}

export function discardArgs(change: Change): string[] {
  if (change.letter === 'U') return ['clean', '-f', '-q', '--', change.path]
  if (change.isNew) return ['rm', '-f', '-q', '--', change.path]
  return ['restore', '--worktree', '--', change.path]
}

/** Discard All on the Changes group: tracked files restored, new files deleted. */
export function discardAllArgs(changes: Change[]): string[][] {
  const pick = (test: (c: Change) => boolean) => changes.filter(c => c.group === 'changes' && test(c)).map(c => c.path)
  const tracked = pick(c => !c.isNew)
  const untracked = pick(c => c.letter === 'U')
  const added = pick(c => Boolean(c.isNew) && c.letter !== 'U')
  return [
    ...(tracked.length ? [['restore', '--worktree', '--', ...tracked]] : []),
    ...(added.length ? [['rm', '-f', '-q', '--', ...added]] : []),
    ...(untracked.length ? [['clean', '-f', '-q', '--', ...untracked]] : []),
  ]
}

export function unstageAllArgs(hasHead: boolean): string[] {
  return hasHead ? ['reset', '-q'] : ['rm', '--cached', '-r', '-q', '--', '.']
}

export function splitPath(path: string): { name: string; dir: string } {
  const at = path.lastIndexOf('/')
  return at < 0 ? { name: path, dir: '' } : { name: path.slice(at + 1), dir: path.slice(0, at) }
}

export function firstLine(text: string): string {
  return text.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('hint:')) ?? ''
}
