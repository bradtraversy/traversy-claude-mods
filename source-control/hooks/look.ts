import type { Change, Letter } from '../types'

// VS Code's gitDecoration colors (Dark Modern).
const DECORATION: Record<Letter, string> = {
  M: '#E2C08D',
  T: '#E2C08D',
  A: '#81B88B',
  D: '#C74E39',
  R: '#73C991',
  C: '#73C991',
  U: '#73C991',
  '!': '#E4676B',
}

export function letterColor(change: Change): string {
  return DECORATION[change.letter]
}

export const HOVER_BG = '#2A2D2E'
export const SELECTED_BG = '#37373D'
export const BADGE_BG = '#616161'
export const BADGE_FG = '#F8F8F8'
export const WARN = '#CCA700'

// Seti's palette, the icon theme VS Code ships with.
const BLUE = '#519ABA'
const YELLOW = '#CBCB41'
const ORANGE = '#E37933'
const RED = '#CC3E44'
const GREEN = '#8DC149'
const PURPLE = '#A074C4'
const PINK = '#F55385'
const GREY = '#6D8086'
const WHITE = '#D4D7D6'

type Icon = { glyph: string; color: string }

const BY_NAME: Record<string, Icon> = {
  'package.json': { glyph: 'np', color: RED },
  'package-lock.json': { glyph: 'np', color: RED },
  'tsconfig.json': { glyph: 'TS', color: BLUE },
  '.gitignore': { glyph: 'gi', color: GREY },
  '.gitattributes': { glyph: 'gi', color: GREY },
  dockerfile: { glyph: 'dk', color: BLUE },
  makefile: { glyph: 'mk', color: ORANGE },
  license: { glyph: 'li', color: YELLOW },
}

const BY_EXT: Record<string, Icon> = {
  ts: { glyph: 'TS', color: BLUE },
  mts: { glyph: 'TS', color: BLUE },
  cts: { glyph: 'TS', color: BLUE },
  tsx: { glyph: '⚛', color: BLUE },
  jsx: { glyph: '⚛', color: BLUE },
  js: { glyph: 'JS', color: YELLOW },
  mjs: { glyph: 'JS', color: YELLOW },
  cjs: { glyph: 'JS', color: YELLOW },
  json: { glyph: '{}', color: YELLOW },
  jsonc: { glyph: '{}', color: YELLOW },
  md: { glyph: 'M↓', color: BLUE },
  mdx: { glyph: 'M↓', color: YELLOW },
  css: { glyph: '#', color: BLUE },
  scss: { glyph: '#', color: PINK },
  html: { glyph: '<>', color: ORANGE },
  svg: { glyph: '◇', color: PURPLE },
  png: { glyph: '▣', color: PURPLE },
  jpg: { glyph: '▣', color: PURPLE },
  jpeg: { glyph: '▣', color: PURPLE },
  gif: { glyph: '▣', color: PURPLE },
  webp: { glyph: '▣', color: PURPLE },
  py: { glyph: 'py', color: BLUE },
  rb: { glyph: 'rb', color: RED },
  go: { glyph: 'go', color: BLUE },
  rs: { glyph: 'rs', color: ORANGE },
  sh: { glyph: '>_', color: GREEN },
  bash: { glyph: '>_', color: GREEN },
  zsh: { glyph: '>_', color: GREEN },
  yml: { glyph: 'yl', color: PURPLE },
  yaml: { glyph: 'yl', color: PURPLE },
  toml: { glyph: 'tm', color: GREY },
  lock: { glyph: 'lk', color: GREY },
  txt: { glyph: '≡', color: WHITE },
  env: { glyph: '⚙', color: GREY },
  sql: { glyph: 'db', color: PINK },
  vue: { glyph: 'V', color: GREEN },
  svelte: { glyph: 'S', color: RED },
  astro: { glyph: 'A', color: ORANGE },
}

const DEFAULT: Icon = { glyph: '≡', color: GREY }

export function fileIcon(name: string): Icon {
  const lower = name.toLowerCase()
  const named = BY_NAME[lower]
  if (named) return named
  if (lower.startsWith('.env')) return BY_EXT.env ?? DEFAULT
  const dot = lower.lastIndexOf('.')
  return (dot > 0 && BY_EXT[lower.slice(dot + 1)]) || DEFAULT
}
