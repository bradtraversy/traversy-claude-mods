import type { EngineInterface, Register, Timer } from 'claude-code'

const MAX_DETAIL_CHARS = 6_000
const MAX_TRACKED_TOOLS = 200

type ToolState = 'running' | 'done' | 'failed' | 'stopped'

type ToolTiming = {
  startedAt: number
  endedAt?: number
}

type ToolDetail = {
  source: string
  format: 'source' | 'diff'
  path?: string
}

const timings = new Map<string, ToolTiming>()
const expansionOverrides = new Map<string, boolean>()
let currentTime = 0
let activeTools = 0
let sessionGeneration = 0
let stopTicker: Timer | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`
}

function clearSessionState(): void {
  sessionGeneration += 1
  timings.clear()
  expansionOverrides.clear()
  currentTime = 0
  activeTools = 0
}

function stopClockTicker(): void {
  stopTicker?.cancel()
  stopTicker = null
}

function rememberTiming(toolUseId: string, timing: ToolTiming): void {
  timings.delete(toolUseId)
  timings.set(toolUseId, timing)

  if (timings.size > MAX_TRACKED_TOOLS) {
    const oldest = timings.keys().next().value
    if (oldest !== undefined) {
      timings.delete(oldest)
      expansionOverrides.delete(oldest)
    }
  }
}

async function readClock($: EngineInterface): Promise<number | undefined> {
  try {
    return await $.clock.now()
  } catch {
    return undefined
  }
}

function startClockTicker($: EngineInterface): void {
  stopClockTicker()
  stopTicker = $.clock.every(1_000, () => {
    if (activeTools === 0) return

    void readClock($).then(now => {
      if (now === undefined || activeTools === 0) return
      currentTime = now
      $.ui.invalidate('ui.render')
    })
  })
}

function compactPath(value: string): string {
  const parts = value.replaceAll('\\', '/').split('/').filter(Boolean)
  return parts.length > 1 ? parts.slice(-2).join('/') : value
}

function quoted(value: string): string {
  return `"${truncate(value, 56)}"`
}

function actionTitle(tool: string, input: unknown): string {
  if (!isRecord(input)) return `${toolLabel(tool)} call`

  const description = asString(input.description)
  if (description) return truncate(description, 78)

  const subject = asString(input.subject)
  if (tool.endsWith('__task_create') && subject) return truncate(subject, 78)
  if (tool.endsWith('__task_update')) return 'Update Work Queue task'
  if (tool.endsWith('__task_list')) return 'Review Work Queue'
  if (tool.endsWith('__task_clear')) return 'Clear Work Queue'

  const filePath = asString(input.file_path) ?? asString(input.path)
  const target = filePath ? compactPath(filePath) : undefined

  if (tool === 'Bash') return 'Run terminal command'
  if (tool === 'Read') return target ? `Read ${target}` : 'Read file'
  if (tool === 'Edit' || tool === 'NotebookEdit') return target ? `Edit ${target}` : 'Edit file'
  if (tool === 'Write') return target ? `Write ${target}` : 'Write file'

  const pattern = asString(input.pattern)
  if (tool === 'Glob') return pattern ? `Find files matching ${quoted(pattern)}` : 'Find files'
  if (tool === 'Grep') return pattern ? `Search for ${quoted(pattern)}` : 'Search project'

  const query = asString(input.query)
  if (tool === 'WebSearch') return query ? `Search the web for ${quoted(query)}` : 'Search the web'

  const url = asString(input.url)
  if (tool === 'WebFetch') return url ? `Open ${truncate(url, 64)}` : 'Open web page'

  if (tool === 'Agent') return subject ? truncate(subject, 78) : 'Run agent task'

  return `${toolLabel(tool)} call`
}

function status(isRunning: boolean, isErrored: boolean, isInterrupted: boolean): ToolState {
  if (isInterrupted) return 'stopped'
  if (isErrored) return 'failed'
  if (isRunning) return 'running'
  return 'done'
}

function statusColor(state: ToolState): 'success' | 'warning' | 'error' | 'inactive' {
  if (state === 'failed') return 'error'
  if (state === 'running') return 'warning'
  if (state === 'stopped') return 'inactive'
  return 'success'
}

function statusLabel(state: ToolState): string {
  if (state === 'running') return 'Running'
  if (state === 'done') return 'Completed'
  if (state === 'failed') return 'Failed'
  return 'Stopped'
}

function toolGlyph(tool: string): string {
  if (tool === 'Bash') return '>_'
  if (tool === 'Read') return '▤'
  if (tool === 'Edit' || tool === 'NotebookEdit') return '✎'
  if (tool === 'Write') return '+'
  if (tool === 'Glob' || tool === 'Grep') return '⌕'
  if (tool === 'WebSearch' || tool === 'WebFetch') return '↗'
  if (tool === 'Agent') return '◎'
  if (tool.startsWith('mcp__')) return '◆'
  return '•'
}

function toolColor(tool: string): string {
  if (tool === 'Bash') return 'claude'
  if (tool === 'Read') return 'ide'
  if (tool === 'Edit' || tool === 'NotebookEdit') return 'diffAdded'
  if (tool === 'Write') return 'success'
  if (tool === 'Glob' || tool === 'Grep') return 'warning'
  if (tool === 'WebSearch' || tool === 'WebFetch') return 'ide'
  if (tool === 'Agent') return 'remember'
  if (tool.startsWith('mcp__')) return 'permission'
  return 'subtle'
}

function toolLabel(tool: string): string {
  if (!tool.startsWith('mcp__')) return truncate(tool, 24)

  const [, server = 'mcp', ...nameParts] = tool.split('__')
  const name = nameParts.join(' ').replaceAll('_', ' ')
  return truncate(`${server}: ${name || 'tool'}`, 24)
}

function lineCount(value: string): number {
  const normalized = value.trimEnd()
  if (!normalized) return 0
  return normalized.split('\n').length
}

function formatCount(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${Math.round(value / 100) / 10}k`
  return `${Math.round(value / 100_000) / 10}m`
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return '<1s'
  if (durationMs < 10_000) {
    const seconds = Math.round(durationMs / 100) / 10
    return `${seconds}s`
  }
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`

  const minutes = Math.floor(durationMs / 60_000)
  const seconds = Math.round((durationMs % 60_000) / 1_000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

function timingLabel(toolUseId: string, output: unknown): string {
  const timing = timings.get(toolUseId)
  if (timing) {
    const endedAt = timing.endedAt ?? currentTime
    return formatDuration(Math.max(0, endedAt - timing.startedAt))
  }

  if (isRecord(output)) {
    const duration = asNumber(output.totalDurationMs) ?? asNumber(output.durationMs)
    if (duration !== undefined) return formatDuration(duration)
  }

  return ''
}

function diffSummary(output: Record<string, unknown>): string {
  const gitDiff = isRecord(output.gitDiff) ? output.gitDiff : undefined
  const additions = gitDiff ? asNumber(gitDiff.additions) : undefined
  const deletions = gitDiff ? asNumber(gitDiff.deletions) : undefined

  if (additions !== undefined && deletions !== undefined) {
    return `+${additions} -${deletions}`
  }

  return ''
}

function bashFileCount(output: Record<string, unknown>): number {
  const editDiff = isRecord(output.bashEditDiff) ? output.bashEditDiff : undefined
  const files = editDiff && Array.isArray(editDiff.files) ? editDiff.files.length : 0
  const moreFiles = editDiff ? asNumber(editDiff.moreFiles) ?? 0 : 0
  return files + moreFiles
}

function resultSummary(tool: string, output: unknown, state: ToolState): string {
  if (state === 'running') return ''
  if (state === 'stopped') return 'Interrupted'
  if (!isRecord(output)) return state === 'failed' ? 'Open details for the error' : ''

  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') {
    if (output.staged === true) return 'Staged for review'
    const summary = diffSummary(output)
    if (summary) return summary
    if (tool === 'Write' && (output.type === 'create' || output.type === 'update')) {
      return output.type === 'create' ? 'File created' : 'File updated'
    }
  }

  if (tool === 'Read') {
    const file = isRecord(output.file) ? output.file : undefined
    const lines = file ? asNumber(file.numLines) : undefined
    const total = file ? asNumber(file.totalLines) : undefined
    if (lines !== undefined && total !== undefined) return `${lines} of ${total} lines`

    const dimensions = file && isRecord(file.dimensions) ? file.dimensions : undefined
    const width = dimensions ? asNumber(dimensions.originalWidth) : undefined
    const height = dimensions ? asNumber(dimensions.originalHeight) : undefined
    if (width !== undefined && height !== undefined) return `${width} x ${height}`
  }

  if (tool === 'Bash') {
    const backgroundTaskId = asString(output.backgroundTaskId)
    if (backgroundTaskId) return `Background task ${backgroundTaskId}`

    const changedFiles = bashFileCount(output)
    if (changedFiles > 0) return `${changedFiles} file${changedFiles === 1 ? '' : 's'} changed`

    const stdout = asString(output.stdout) ?? ''
    const stderr = asString(output.stderr) ?? ''
    const outputLines = lineCount(stdout) + lineCount(stderr)
    if (outputLines > 0) return `${outputLines} output line${outputLines === 1 ? '' : 's'}`
    if (output.noOutputExpected === true) return 'No output expected'
  }

  if (tool === 'Agent' && output.status === 'completed') {
    const parts: string[] = []
    const tokens = asNumber(output.totalTokens)
    const tools = asNumber(output.totalToolUseCount)
    if (tokens !== undefined) parts.push(`${formatCount(tokens)} tokens`)
    if (tools !== undefined) parts.push(`${tools} tool${tools === 1 ? '' : 's'}`)
    return parts.join(' | ')
  }

  return state === 'failed' ? 'Open details for the error' : ''
}

function outputDetail(tool: string, output: unknown): ToolDetail | null {
  if (typeof output === 'string' && output) {
    try {
      const parsed = JSON.parse(output)
      if (isRecord(parsed) || Array.isArray(parsed)) {
        return {
          source: truncate(JSON.stringify(parsed, null, 2), MAX_DETAIL_CHARS),
          format: 'source',
        }
      }
    } catch {
      // Plain-text output stays plain text.
    }

    return {
      source: truncate(output, MAX_DETAIL_CHARS),
      format: 'source',
    }
  }

  if (!isRecord(output)) return null

  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') {
    const gitDiff = isRecord(output.gitDiff) ? output.gitDiff : undefined
    const patch = gitDiff ? asString(gitDiff.patch) : undefined
    if (patch) {
      if (patch.length > MAX_DETAIL_CHARS) {
        return {
          source: `Diff is too large to display (${Math.round(patch.length / 1_000)}k characters).`,
          format: 'source',
        }
      }

      return {
        source: patch,
        format: 'diff',
        path: gitDiff ? asString(gitDiff.filename) : undefined,
      }
    }
  }

  if (tool === 'Bash') {
    const stdout = asString(output.stdout) ?? ''
    const stderr = asString(output.stderr) ?? ''
    const sections = [
      stdout ? stdout.trimEnd() : '',
      stderr ? `stderr:\n${stderr.trimEnd()}` : '',
    ].filter(Boolean)

    if (sections.length > 0) {
      return {
        source: truncate(sections.join('\n\n'), MAX_DETAIL_CHARS),
        format: 'source',
      }
    }
  }

  if (typeof output.text === 'string' && output.text) {
    return {
      source: truncate(output.text, MAX_DETAIL_CHARS),
      format: 'source',
    }
  }

  const serialized = JSON.stringify(output, null, 2)
  if (serialized) {
    return {
      source: truncate(serialized, MAX_DETAIL_CHARS),
      format: 'source',
    }
  }

  return null
}

export const register: Register = on => {
  on('session.start', async ($, event, next) => {
    stopClockTicker()
    clearSessionState()
    currentTime = await readClock($) ?? 0
    startClockTicker($)
    return next(event)
  })

  on('session.end', ($, event, next) => {
    clearSessionState()
    if (event.reason !== 'clear' && event.reason !== 'resume') stopClockTicker()
    $.ui.invalidate('ui.render')
    return next(event)
  })

  on('tool.call', async ($, event, next) => {
    const generation = sessionGeneration
    const startedAt = await readClock($)

    if (startedAt !== undefined && generation === sessionGeneration) {
      currentTime = startedAt
      rememberTiming(event.tool_use_id, { startedAt })
      activeTools += 1
      $.ui.invalidate('ui.render')
    }

    try {
      return await next(event)
    } finally {
      if (generation === sessionGeneration && startedAt !== undefined) {
        const endedAt = await readClock($)
        if (generation === sessionGeneration) {
          activeTools = Math.max(0, activeTools - 1)
          if (endedAt !== undefined) {
            currentTime = endedAt
            rememberTiming(event.tool_use_id, { startedAt, endedAt })
            $.ui.invalidate('ui.render')
          } else {
            timings.delete(event.tool_use_id)
          }
        }
      }
    }
  })

  on('ui.render', { component: 'ToolGroup' }, ($, event, next) => {
    if (event.props.isExpanded) return next(event)

    return next({
      ...event,
      props: {
        ...event.props,
        isExpanded: true,
      },
    })
  })

  on('ui.render', { component: 'ToolUse' }, ($, event) => {
    const { Box, Button, Code, Text } = $.ui.resolve(event)
    const state = status(event.props.isRunning, event.props.isErrored, event.props.isInterrupted)
    const color = statusColor(state)
    const summary = resultSummary(event.props.tool, event.props.output, state)
    const duration = timingLabel(event.props.tool_use_id, event.props.output)
    const detail = outputDetail(event.props.tool, event.props.output)
    const expanded = expansionOverrides.get(event.props.tool_use_id) ?? event.props.isErrored
    const toggleDetails = (): void => {
      expansionOverrides.set(event.props.tool_use_id, !expanded)
      $.ui.invalidate('ui.render')
    }

    if (event.surface === 'vscode') {
      return (
        <Box flexDirection="column" minWidth={0} overflow="hidden" paddingX={0.5} paddingY={0.25}>
          <Box alignItems="center" gap={1} overflow="hidden">
            <Text color={toolColor(event.props.tool)} bold>{toolGlyph(event.props.tool)}</Text>
            <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
              <Text bold wrap="truncate-middle">{actionTitle(event.props.tool, event.props.input)}</Text>
            </Box>
            <Text color={color}>{statusLabel(state)}</Text>
            <Text dimColor>{toolLabel(event.props.tool)}</Text>
            {duration && <Text dimColor>{duration}</Text>}
            {summary && <Text dimColor wrap="truncate-middle">{summary}</Text>}
            {detail && (
              <Box flexShrink={0}>
                <Button
                  key={`tool-card-details:${event.props.tool_use_id}`}
                  label={expanded ? 'Hide details' : 'Details'}
                  variant="secondary"
                  onPress={toggleDetails}
                />
              </Box>
            )}
          </Box>
          {detail && expanded && (
            <Code source={detail.source} format={detail.format} path={detail.path} wrap="truncate-end" />
          )}
        </Box>
      )
    }

    if (event.surface === 'terminal') {
      return (
        <Box flexDirection="column" overflow="hidden">
          <Box justifyContent="space-between" alignItems="center" gap={1} overflow="hidden">
            <Box gap={1} flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
              <Text color={toolColor(event.props.tool)} bold>{toolGlyph(event.props.tool)}</Text>
              <Text bold wrap="truncate-middle">
                {actionTitle(event.props.tool, event.props.input)}
              </Text>
            </Box>
            {detail && (
              <Box flexShrink={0}>
                <Button
                  key={`tool-card-details:${event.props.tool_use_id}`}
                  label={expanded ? 'Hide details' : 'Details'}
                  variant="secondary"
                  onPress={toggleDetails}
                />
              </Box>
            )}
          </Box>
          <Box marginLeft={3} gap={1} alignItems="center" flexWrap="wrap" overflow="hidden">
            <Text color={color} bold>{statusLabel(state)}</Text>
            <Text dimColor>·</Text>
            <Text dimColor>{toolLabel(event.props.tool)}</Text>
            {duration && <Text dimColor>·</Text>}
            {duration && <Text dimColor>{duration}</Text>}
            {summary && <Text dimColor>·</Text>}
            {summary && <Text dimColor wrap="truncate-middle">{summary}</Text>}
          </Box>
          {detail && expanded && (
            <Box marginLeft={3} marginTop={1}>
              <Code
                source={detail.source}
                format={detail.format}
                path={detail.path}
                wrap="truncate-end"
              />
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box
        borderStyle="round"
        borderDimColor
        paddingX={2}
        paddingY={1}
        marginY={1}
        flexDirection="column"
        overflow="hidden"
        gap={1}
      >
        <Box justifyContent="space-between" alignItems="center" gap={2} overflow="hidden">
          <Box
            gap={2}
            alignItems="center"
            flexGrow={1}
            flexShrink={1}
            minWidth={0}
            overflow="hidden"
          >
            <Box
              borderStyle="round"
              borderColor={toolColor(event.props.tool)}
              backgroundColor={toolColor(event.props.tool)}
              paddingX={1}
              flexShrink={0}
            >
              <Text color="inverseText" bold>{toolGlyph(event.props.tool)}</Text>
            </Box>
            <Box
              flexDirection="column"
              flexGrow={1}
              flexShrink={1}
              minWidth={0}
              overflow="hidden"
            >
              <Text bold wrap="truncate-middle">
                {actionTitle(event.props.tool, event.props.input)}
              </Text>
              <Box gap={1} alignItems="center" flexWrap="wrap" overflow="hidden">
                <Text color={color} bold>{statusLabel(state)}</Text>
                <Text dimColor>·</Text>
                <Text dimColor>{toolLabel(event.props.tool)}</Text>
                {duration && <Text dimColor>·</Text>}
                {duration && <Text dimColor>{duration}</Text>}
                {summary && <Text dimColor>·</Text>}
                {summary && <Text dimColor wrap="truncate-middle">{summary}</Text>}
              </Box>
            </Box>
          </Box>
          {detail && (
            <Box flexShrink={0}>
              <Button
                key={`tool-card-details:${event.props.tool_use_id}`}
                label={expanded ? 'Hide details' : 'Details'}
                variant="secondary"
                onPress={toggleDetails}
              />
            </Box>
          )}
        </Box>
        {detail && expanded && (
          <Box marginLeft={7} paddingX={1} paddingY={1} borderStyle="round" borderDimColor>
            <Code
              source={detail.source}
              format={detail.format}
              path={detail.path}
              wrap="truncate-end"
            />
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'ToolResult' }, ($, event) => {
    const { Box } = $.ui.resolve(event)
    return <Box />
  })
}
