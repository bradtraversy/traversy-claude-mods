export type Letter = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '!'

export type Group = 'merge' | 'staged' | 'changes'

export type Change = {
  /** Repo-relative, as git prints it. */
  path: string
  /** The source path of a rename or copy. */
  orig?: string
  letter: Letter
  group: Group
  /** Untracked, or added with --intent-to-add: discarding deletes the file. */
  isNew?: boolean
}

export type RefKind = 'head' | 'branch' | 'remote' | 'tag'

export type Ref = { name: string; kind: RefKind }

export type Commit = {
  hash: string
  parents: string[]
  author: string
  date: string
  refs: Ref[]
  subject: string
}

/** A file a commit changed, against its first parent. */
export type CommitFile = { path: string; orig?: string; letter: Letter }

/** One line of `git log --graph`: the graph prefix, and the commit it carries (-1 for a connector line). */
export type GraphRow = { graph: string; commit: number }

export type Repo = {
  root: string
  branch: string
  isDetached: boolean
  hasHead: boolean
  upstream: string
  ahead: number
  behind: number
  changes: Change[]
  commits: Commit[]
  rows: GraphRow[]
}

export type Scm = { repo: Repo | null; error: string }

export type Confirm =
  | { kind: 'discard'; path: string }
  | { kind: 'discard-all' }
  | { kind: 'commit-all' }

declare module 'claude-code' {
  interface PluginState {
    'source-control': {
      scm: Shaped<Scm>
      draft: string
      field: number
      collapsed: string[]
      confirm: Confirm | null
      busy: string
      limit: number
      expanded: string[]
      files: Shaped<Record<string, CommitFile[]>>
    }
  }
}
