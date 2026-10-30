import type { EngineInterface } from 'claude-code'

// vscode-icons, the file icon theme Brad's VS Code uses, read from where VS Code installed it.
const PUBLISHER = 'vscode-icons-team.vscode-icons-'
const THEME_FILE = 'dist/src/vsicons-icon-theme.json'
// What an Svg element takes; a bigger icon keeps its letter.
const MAX_SVG = 131_072

export const ICON_SIZE = 16

/** The theme's file associations, keys lowercased as VS Code matches them. */
export type IconTheme = {
  file: string
  fileNames: Record<string, string>
  fileExtensions: Record<string, string>
  languageIds: Record<string, string>
}

type LoadedTheme = IconTheme & { paths: Record<string, string> }

// VS Code's language for a file the theme maps by language rather than by name or extension.
const LANGUAGE_BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  '.bashrc': 'shellscript',
  '.bash_profile': 'shellscript',
  '.profile': 'shellscript',
  '.zshrc': 'shellscript',
  '.env': 'dotenv',
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  es6: 'javascript',
  jsx: 'javascriptreact',
  md: 'markdown',
  markdown: 'markdown',
  mdown: 'markdown',
  mkd: 'markdown',
  mdx: 'mdx',
  json: 'json',
  jsonc: 'jsonc',
  jsonl: 'jsonl',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  py: 'python',
  pyi: 'python',
  pyw: 'python',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  ksh: 'shellscript',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  java: 'java',
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  cs: 'csharp',
  php: 'php',
  xml: 'xml',
  sql: 'sql',
  vue: 'vue',
  svelte: 'svelte',
  graphql: 'graphql',
  gql: 'graphql',
  ps1: 'powershell',
  bat: 'bat',
  cmd: 'bat',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  lua: 'lua',
  dart: 'dart',
  ini: 'ini',
  diff: 'diff',
  patch: 'diff',
}

function languageOf(lower: string): string | undefined {
  const named = LANGUAGE_BY_NAME[lower]
  if (named) return named
  if (lower.startsWith('.env.')) return 'dotenv'
  const dot = lower.lastIndexOf('.')
  return dot > 0 ? LANGUAGE_BY_EXT[lower.slice(dot + 1)] : undefined
}

/**
 * The icon VS Code shows for a file name: the exact name, then the longest
 * extension the theme lists (`test.ts` before `ts`), then the language, then
 * the theme's default file icon.
 */
export function resolveIcon(theme: IconTheme, name: string): string {
  const lower = name.toLowerCase()
  const named = theme.fileNames[lower]
  if (named) return named
  const parts = lower.split('.')
  for (let i = 1; i < parts.length; i++) {
    const byExt = theme.fileExtensions[parts.slice(i).join('.')]
    if (byExt) return byExt
  }
  const language = languageOf(lower)
  return (language && theme.languageIds[language]) || theme.file
}

function lowerKeys(map: unknown, skip?: (key: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {}
  if (!map || typeof map !== 'object') return out
  for (const [key, id] of Object.entries(map)) {
    if (typeof id === 'string' && !skip?.(key)) out[key.toLowerCase()] = id
  }
  return out
}

/** `a/b/../../c.svg` against `/x/y`, as the theme's relative icon paths need. */
function join(dir: string, rel: string): string {
  const out = dir.split('/')
  for (const part of rel.split('/')) {
    if (part === '..') out.pop()
    else if (part && part !== '.') out.push(part)
  }
  return out.join('/')
}

async function readTheme($: EngineInterface): Promise<LoadedTheme | null> {
  const home = await $.env.get('HOME')
  if (!home) return null
  const root = `${home}/.vscode/extensions`
  const newest = (await $.fs.list(root))
    .filter(entry => entry.name.startsWith(PUBLISHER) && (entry.kind === 'dir' || entry.isLink))
    .map(entry => entry.name)
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))[0]
  if (!newest) return null
  const path = `${root}/${newest}/${THEME_FILE}`
  const doc = JSON.parse(await $.fs.read(path)) as Record<string, unknown>
  const defs = doc.iconDefinitions
  if (typeof doc.file !== 'string' || !defs || typeof defs !== 'object') return null
  const dir = path.slice(0, path.lastIndexOf('/'))
  const paths: Record<string, string> = {}
  for (const [id, def] of Object.entries(defs)) {
    const rel = (def as { iconPath?: unknown } | null)?.iconPath
    if (typeof rel === 'string') paths[id] = join(dir, rel)
  }
  return {
    file: doc.file,
    // A `parent/name` key matches by folder too; the rows go by name alone.
    fileNames: lowerKeys(doc.fileNames, key => key.includes('/')),
    fileExtensions: lowerKeys(doc.fileExtensions, key => key.includes('/')),
    languageIds: lowerKeys(doc.languageIds),
    paths,
  }
}

let theme: Promise<LoadedTheme | null> | null = null
const svgs = new Map<string, Promise<string | null>>()

function loadTheme($: EngineInterface): Promise<LoadedTheme | null> {
  theme ??= readTheme($).catch(() => null)
  return theme
}

function readSvg($: EngineInterface, path: string): Promise<string | null> {
  let svg = svgs.get(path)
  if (!svg) {
    svg = $.fs.read(path).then(
      text => (text.length <= MAX_SVG && text.includes('<svg') ? text : null),
      () => null,
    )
    svgs.set(path, svg)
  }
  return svg
}

/**
 * Each file name's vscode-icons SVG, read once and kept; a name is absent when
 * the theme or its icon is missing, so its row keeps the letter icon.
 */
export async function fileSvgs($: EngineInterface, names: Iterable<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const loaded = await loadTheme($)
  if (!loaded) return out
  await Promise.all(
    [...new Set(names)].map(async name => {
      const path = loaded.paths[resolveIcon(loaded, name)]
      const svg = path ? await readSvg($, path) : null
      if (svg) out.set(name, svg)
    }),
  )
  return out
}
