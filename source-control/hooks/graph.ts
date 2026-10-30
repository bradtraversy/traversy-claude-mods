import type { Commit } from '../types'

// VS Code's scmGraph colors (Dark Modern): the current branch, its upstream, then the lane rotation.
export const REF_COLOR = '#3794FF'
export const REMOTE_COLOR = '#B180D7'
export const LANE_COLORS = ['#FFB000', '#DC267F', '#994F00', '#40B0A6', '#B66DFF']

// VS Code's swimlane metrics, in CSS pixels.
const HEIGHT = 22
const WIDTH = 11
const CURVE = 5
const RADIUS = 4

type Lane = { id: string; color: string }

export type GraphNode = { input: Lane[]; output: Lane[]; isHead: boolean }

/** VS Code's swimlane layout (toISCMHistoryItemViewModelArray): each commit's lanes in and out. */
export function layout(commits: Commit[], upstream: string): GraphNode[] {
  const nodes: GraphNode[] = []
  let rotation = -1
  const labelColor = (commit: Commit | undefined) => {
    for (const ref of commit?.refs ?? []) {
      if (ref.kind === 'head') return REF_COLOR
      if (ref.kind === 'remote' && ref.name === upstream) return REMOTE_COLOR
    }
    return undefined
  }
  for (const commit of commits) {
    const input = (nodes.at(-1)?.output ?? []).map(lane => ({ ...lane }))
    const output: Lane[] = []
    let firstParent = false
    if (commit.parents.length > 0) {
      for (const lane of input) {
        if (lane.id === commit.hash) {
          if (!firstParent) {
            output.push({ id: commit.parents[0] ?? '', color: labelColor(commit) ?? lane.color })
            firstParent = true
          }
          continue
        }
        output.push({ ...lane })
      }
    }
    for (let i = firstParent ? 1 : 0; i < commit.parents.length; i++) {
      const parent = commit.parents[i] ?? ''
      let color = i === 0 ? labelColor(commit) : labelColor(commits.find(c => c.hash === parent))
      if (!color) {
        rotation = (rotation + 1) % LANE_COLORS.length
        color = LANE_COLORS[rotation] ?? REF_COLOR
      }
      output.push({ id: parent, color })
    }
    nodes.push({ input, output, isHead: commit.refs.some(r => r.kind === 'head') })
  }
  return nodes
}

export function graphWidth(node: GraphNode): number {
  return WIDTH * (Math.max(node.input.length, node.output.length, 1) + 1)
}

/** One commit's row of the graph as an SVG document, drawn as VS Code's renderSCMHistoryItemGraph draws it. */
export function rowSvg(commit: Commit, node: GraphNode): string {
  const { input, output } = node
  const x = (lane: number) => WIDTH * (lane + 1)
  const mid = HEIGHT / 2
  let circle = input.findIndex(lane => lane.id === commit.hash)
  if (circle === -1) circle = input.length
  const circleColor = output[circle]?.color ?? input[circle]?.color ?? REF_COLOR
  const paths: string[] = []
  const path = (d: string, color: string) => paths.push(`<path d="${d}" stroke="${color}"/>`)

  let out = 0
  for (let index = 0; index < input.length; index++) {
    const lane = input[index]
    if (!lane) continue
    if (lane.id === commit.hash) {
      if (index !== circle) path(`M ${x(index)} 0 A ${WIDTH} ${WIDTH} 0 0 1 ${WIDTH * index} ${mid} H ${x(circle)}`, lane.color)
      else out++
      continue
    }
    if (out < output.length && lane.id === output[out]?.id) {
      if (index === out) path(`M ${x(index)} 0 V ${HEIGHT}`, lane.color)
      else path(`M ${x(index)} 0 V 6 A ${CURVE} ${CURVE} 0 0 1 ${x(index) - CURVE} ${mid} H ${x(out) + CURVE} A ${CURVE} ${CURVE} 0 0 0 ${x(out)} ${mid + CURVE} V ${HEIGHT}`, lane.color)
      out++
    }
  }
  for (let i = 1; i < commit.parents.length; i++) {
    let at = -1
    for (let j = output.length - 1; j >= 0; j--) if (output[j]?.id === commit.parents[i]) { at = j; break }
    if (at === -1) continue
    const color = output[at]?.color ?? circleColor
    path(`M ${WIDTH * at} ${mid} A ${WIDTH} ${WIDTH} 0 0 1 ${x(at)} ${HEIGHT} M ${WIDTH * at} ${mid} H ${x(circle)}`, color)
  }
  if (circle < input.length) path(`M ${x(circle)} 0 V ${mid}`, input[circle]?.color ?? circleColor)
  if (commit.parents.length > 0) path(`M ${x(circle)} ${mid} V ${HEIGHT}`, circleColor)

  const cx = x(circle)
  const dot = node.isHead
    ? `<circle cx="${cx}" cy="${mid}" r="${RADIUS + 1}" fill="none" stroke="${circleColor}" stroke-width="2"/>`
    : commit.parents.length > 1
      ? `<circle cx="${cx}" cy="${mid}" r="${RADIUS + 1}" fill="none" stroke="${circleColor}" stroke-width="1.5"/><circle cx="${cx}" cy="${mid}" r="${RADIUS - 1.5}" fill="${circleColor}"/>`
      : `<circle cx="${cx}" cy="${mid}" r="${RADIUS}" fill="${circleColor}"/>`
  const width = graphWidth(node)
  // The mask keeps lines out of a hollow circle without knowing the background behind it. Its id
  // is the commit's, so rows a surface inlines into one document do not share it.
  const mask = `m${commit.hash.slice(0, 12)}`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" viewBox="0 0 ${width} ${HEIGHT}">` +
    `<defs><mask id="${mask}"><rect width="${width}" height="${HEIGHT}" fill="#fff"/><circle cx="${cx}" cy="${mid}" r="${RADIUS + 2}" fill="#000"/></mask></defs>` +
    `<g mask="url(#${mask})" fill="none" stroke-width="1" stroke-linecap="round">${paths.join('')}</g>${dot}</svg>`
  )
}

export const ROW_HEIGHT = HEIGHT

/** The lanes running on past a commit, for the rows of its expanded files. */
export function passSvg(node: GraphNode): string {
  const width = graphWidth(node)
  const lines = node.output.map((lane, i) => `<path d="M ${WIDTH * (i + 1)} 0 V ${HEIGHT}" stroke="${lane.color}"/>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" viewBox="0 0 ${width} ${HEIGHT}"><g fill="none" stroke-width="1">${lines}</g></svg>`
}

// VS Code's ref label: an 18px pill with fully round ends, 6px padding, white text.
const PILL_HEIGHT = 18
const PILL_PAD = 6
const PILL_FONT = 13
const PILL_MAX = 24

const escapeXml = (text: string) => text.replace(/[&<>"]/g, ch => `&#${ch.charCodeAt(0)};`)

/** About how wide a label's text draws in the pane's sans font: widths at 12px, scaled to PILL_FONT; centered, so a miss spreads to both sides. */
function textWidth(text: string): number {
  let px = 0
  for (const ch of text) px += /[ilj.,:;'|!\/tfr\s-]/.test(ch) ? 3.8 : /[A-Z@mwMW]/.test(ch) ? 9 : ch === '☁' ? 12 : 6.8
  return Math.ceil((px * PILL_FONT) / 12)
}

/** A ref label drawn as VS Code draws it, for a surface that has Svg. */
export function pillSvg(label: string, color: string): { source: string; width: number; height: number } {
  const text = label.length > PILL_MAX ? `${label.slice(0, PILL_MAX - 3)}...` : label
  const width = textWidth(text) + PILL_PAD * 2
  const h = PILL_HEIGHT
  return {
    source:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">` +
      `<rect width="${width}" height="${h}" rx="${h / 2}" fill="${color}"/>` +
      `<text x="${width / 2}" y="${h / 2}" fill="#FFFFFF" font-family="system-ui, Ubuntu, 'Segoe UI', sans-serif" font-size="${PILL_FONT}" text-anchor="middle" dominant-baseline="central">${escapeXml(text)}</text></svg>`,
    width,
    height: h,
  }
}

const GLYPHS: Record<string, string> = { '*': '●', '|': '│', '/': '╱', '\\': '╲', '-': '─', _: '_', '.': '·' }

/** A `git log --graph` prefix as colored runs: one color per lane, two columns to a lane, as git draws it. */
export function textGraph(prefix: string, isHead = false): { text: string; color?: string }[] {
  const runs: { text: string; color?: string }[] = []
  for (let col = 0; col < prefix.length; col++) {
    const ch = prefix[col] ?? ' '
    if (ch === ' ') {
      const last = runs.at(-1)
      if (last && last.color === undefined) last.text += ' '
      else runs.push({ text: ' ' })
      continue
    }
    // A slash sits between two lanes: it belongs to the one it leaves from.
    const lane = Math.floor((ch === '/' ? col + 1 : ch === '\\' ? col - 1 : col) / 2)
    const glyph = ch === '*' && isHead ? '◉' : (GLYPHS[ch] ?? ch)
    // Lane 0 is the current branch's, blue as in the drawn graph.
    runs.push({ text: glyph, color: lane === 0 ? REF_COLOR : (LANE_COLORS[(lane - 1) % LANE_COLORS.length] ?? REF_COLOR) })
  }
  return runs
}
