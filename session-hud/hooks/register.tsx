import type {
  ContextMcpTool,
  EngineInterface,
  Register,
  SessionContextBreakdown,
  SessionRateLimit,
  SessionUsage,
} from 'claude-code'
import {
  DEFAULT_CONTEXT_MAX_TOKENS,
  MAX_CONTEXT_MAX_TOKENS,
  MIN_CONTEXT_MAX_TOKENS,
} from './config.ts'

const PANE = 'context-breakdown'
const MCP_SERVER_LIMIT = 5
const MCP_TOOLS_PER_PAGE = 10
const BRANCH_REFRESH_INTERVAL_MS = 5_000

let breakdown: SessionContextBreakdown | null = null
let breakdownError = ''
let breakdownLoading = false
let detailUsage: SessionUsage | null = null
let selectedMcpServer: string | null = null
let mcpPage = 0
let branchRefreshStarted = false
let branchRefreshing = false
let editingContextTarget = false
let contextTargetDraft = ''
let contextTargetError = ''
let breakdownGeneration = 0

type BranchState = {
  kind: 'loading' | 'branch' | 'default' | 'detached' | 'none' | 'error'
  label: string
}

let branchState: BranchState = {
  kind: 'loading',
  label: 'Checking branch',
}

type McpServerGroup = {
  name: string
  loadedTokens: number
  loadedTools: number
  deferredTools: number
  tools: ContextMcpTool[]
}

function clearSessionDetails(): void {
  breakdownGeneration += 1
  breakdown = null
  breakdownError = ''
  breakdownLoading = false
  detailUsage = null
  selectedMcpServer = null
  mcpPage = 0
  editingContextTarget = false
  contextTargetDraft = ''
  contextTargetError = ''
}

function meter(percent: number, width: number): { filled: string; remaining: string } {
  const safePercent = Math.min(Math.max(percent, 0), 100)
  const rounded = Math.round((safePercent / 100) * width)
  const filled = safePercent > 0 ? Math.max(1, rounded) : 0
  return {
    filled: '█'.repeat(filled),
    remaining: '░'.repeat(width - filled),
  }
}

function rateLimitLabel(kind: string): string {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return '7d'
  return kind.replaceAll('_', ' ')
}

function rateLimitTitle(limit: SessionRateLimit): string {
  if (limit.kind === 'five_hour') return 'Five-hour usage'
  if (limit.kind === 'seven_day') return 'Weekly usage'
  return rateLimitLabel(limit.kind)
}

function resetLabel(resetsAt?: string): string {
  if (!resetsAt) return ''

  const date = new Date(resetsAt)
  if (Number.isNaN(date.getTime())) return ''

  return `Resets ${date.toLocaleString([], {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })}`
}

function tokenLabel(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}m`
  }

  return `${Math.round(tokens / 1_000)}k`
}

function modelWindowLabel(tokens: number): string {
  return tokenLabel(tokens).replace(/m$/, 'M')
}

function detailTokenLabel(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}m`
  }

  if (tokens >= 10_000) return `${Math.round(tokens / 1_000)}k`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return tokens.toLocaleString()
}

function targetHeadroomLabel(tokens: number, target: number): string {
  const remaining = target - tokens
  if (remaining === 0) return 'At target'
  if (remaining > 0) return `${detailTokenLabel(remaining)} until target`
  return `${detailTokenLabel(Math.abs(remaining))} over target`
}

function contextMaxTokens(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_CONTEXT_MAX_TOKENS
  }

  return Math.min(
    MAX_CONTEXT_MAX_TOKENS,
    Math.max(MIN_CONTEXT_MAX_TOKENS, Math.round(value)),
  )
}

function parseContextTarget(answer: string): number | null {
  const normalized = answer.trim().toLowerCase().replaceAll(',', '').replaceAll('_', '')
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*([km])?$/)
  if (!match) return null

  const amount = Number(match[1])
  const multiplier = match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1
  const tokens = Math.round(amount * multiplier)

  if (tokens < MIN_CONTEXT_MAX_TOKENS || tokens > MAX_CONTEXT_MAX_TOKENS) return null
  return tokens
}

async function saveContextTarget($: EngineInterface, answer: string): Promise<void> {
  contextTargetDraft = answer
  contextTargetError = ''

  try {
    const target = parseContextTarget(answer)

    if (!target) {
      contextTargetError = 'Enter 10k to 10m, such as 300k or 1m.'
      $.ui.invalidate('ui.render')
      return
    }

    const result = await $.config.set({
      key: 'session-hud.context_max_tokens',
      value: target,
    })

    if ('deny' in result && result.deny) {
      contextTargetError = result.deny
      $.ui.invalidate('ui.render')
      return
    }

    editingContextTarget = false
    contextTargetError = ''
    $.ui.invalidate('ui.render')
  } catch {
    contextTargetError = 'The context target could not be saved.'
    $.ui.invalidate('ui.render')
  }
}

function percentage(tokens: number, total: number): string {
  if (total <= 0) return '0%'
  const value = (tokens / total) * 100
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)}%`
}

function usageColor(percent: number): 'success' | 'warning' | 'error' {
  if (percent >= 90) return 'error'
  if (percent >= 70) return 'warning'
  return 'success'
}

function branchColor(kind: BranchState['kind']): 'success' | 'warning' | 'inactive' {
  if (kind === 'branch') return 'success'
  if (kind === 'default' || kind === 'detached') return 'warning'
  return 'inactive'
}

function compactBranchName(name: string, maxLength = 36): string {
  if (name.length <= maxLength) return name

  const tailLength = 10
  const headLength = maxLength - tailLength - 3
  return `${name.slice(0, headLength)}...${name.slice(-tailLength)}`
}

function updateBranch($: EngineInterface, nextState: BranchState): void {
  if (branchState.kind === nextState.kind && branchState.label === nextState.label) return

  branchState = nextState
  $.ui.invalidate('ui.render')
}

async function refreshBranch($: EngineInterface, cwd?: string): Promise<void> {
  if (branchRefreshing) return

  branchRefreshing = true

  try {
    const directory = cwd ?? await $.session.cwd()
    const current = await $.process.run(['git', 'branch', '--show-current'], {
      cwd: directory,
      timeoutMs: 5_000,
    })

    if (current.exitCode !== 0) {
      updateBranch($, { kind: 'none', label: 'Not a Git repository' })
      return
    }

    const name = current.stdout.trim()
    if (name) {
      updateBranch($, {
        kind: name === 'main' || name === 'master' ? 'default' : 'branch',
        label: compactBranchName(name),
      })
      return
    }

    const commit = await $.process.run(['git', 'rev-parse', '--short', 'HEAD'], {
      cwd: directory,
      timeoutMs: 5_000,
    })
    const shortCommit = commit.stdout.trim()

    updateBranch($, commit.exitCode === 0 && shortCommit
      ? { kind: 'detached', label: `detached@${shortCommit}` }
      : { kind: 'none', label: 'Not a Git repository' })
  } catch {
    updateBranch($, { kind: 'error', label: 'Branch unavailable' })
  } finally {
    branchRefreshing = false
  }
}

function friendlyName(value: string, maxLength = 28): string {
  const readable = value.replaceAll('_', ' ')
  if (readable.length <= maxLength) return readable
  return `${readable.slice(0, Math.max(1, maxLength - 3))}...`
}

function toolName(tool: ContextMcpTool): string {
  const prefix = `mcp__${tool.serverName}__`
  const shortName = tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name
  return friendlyName(shortName, 32)
}

function groupMcpTools(tools: readonly ContextMcpTool[]): McpServerGroup[] {
  const groups = new Map<string, ContextMcpTool[]>()

  for (const tool of tools) {
    const group = groups.get(tool.serverName) ?? []
    group.push(tool)
    groups.set(tool.serverName, group)
  }

  return [...groups.entries()]
    .map(([name, serverTools]) => ({
      name,
      loadedTokens: serverTools
        .filter(tool => tool.isLoaded)
        .reduce((total, tool) => total + tool.tokens, 0),
      loadedTools: serverTools.filter(tool => tool.isLoaded).length,
      deferredTools: serverTools.filter(tool => !tool.isLoaded).length,
      tools: [...serverTools].sort((left, right) => {
        if (left.isLoaded !== right.isLoaded) return left.isLoaded ? -1 : 1
        return right.tokens - left.tokens || left.name.localeCompare(right.name)
      }),
    }))
    .sort((left, right) => {
      return right.loadedTokens - left.loadedTokens || left.name.localeCompare(right.name)
    })
}

async function refreshBreakdown(
  $: EngineInterface,
  columns: number,
  generation = breakdownGeneration,
): Promise<void> {
  if (breakdownLoading) return
  if (generation !== breakdownGeneration) return

  breakdownLoading = true
  breakdownError = ''
  $.ui.invalidate('ui.render')

  try {
    const usage = await $.session.usage({ breakdown: 'full', columns })
    if (generation !== breakdownGeneration) return
    detailUsage = usage
    breakdown = usage.context.breakdown ?? null
    if (!breakdown) breakdownError = 'Claude Code did not return a context breakdown yet.'
  } catch (error) {
    if (generation !== breakdownGeneration) return
    breakdownError = error instanceof Error ? error.message : String(error)
  } finally {
    if (generation === breakdownGeneration) {
      breakdownLoading = false
      $.ui.invalidate('ui.render')
    }
  }
}

async function isBreakdownOpen($: EngineInterface): Promise<boolean> {
  try {
    const pane = (await $.ui.panes()).find(item => item.id === PANE)
    return Boolean(pane?.isPlaced && pane.isShown)
  } catch {
    return false
  }
}

async function openBreakdown($: EngineInterface, surface: string): Promise<void> {
  const generation = breakdownGeneration
  const columns = surface === 'terminal' ? 52 : 58
  selectedMcpServer = null
  mcpPage = 0
  await $.ui.open({
    id: PANE,
    title: 'Session',
    focus: true,
    closeOnEscape: true,
    columns,
  })
  await refreshBreakdown($, columns, generation)
}

export const register: Register = (on, options) => {
  const contextTarget = contextMaxTokens(options.context_max_tokens)

  on('session.start', async ($, event, next) => {
    clearSessionDetails()
    branchState = { kind: 'loading', label: 'Checking branch' }
    await refreshBranch($, event.cwd)

    if (!branchRefreshStarted) {
      branchRefreshStarted = true
      $.clock.every(BRANCH_REFRESH_INTERVAL_MS, () => {
        void refreshBranch($)
      })
    }

    return next(event)
  })

  on('session.end', ($, event, next) => {
    if (event.reason === 'clear' || event.reason === 'resume') {
      clearSessionDetails()
      $.ui.invalidate('ui.render')
    }
    return next(event)
  })

  on('tool.call', { tool: 'Bash' }, async ($, event, next) => {
    const result = await next(event)
    await refreshBranch($)
    return result
  }).catch(($, event, next) => next(event))

  on('session.measure', ($, event, next) => {
    $.ui.invalidate('ui.render')
    return next(event)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, event, next) => {
    if (event.props.hasSurvey) return next(event)

    // Bands other mods draw beneath this hook only show if passed on.
    const rest = await next(event)
    const { Box, Button, Text } = $.ui.resolve(event)
    const usage = await $.session.usage()
    const tokens = usage.context.tokens ?? 0
    const percent = Math.max(0, Math.round((tokens / contextTarget) * 100))
    // The desktop draws block glyphs wider than a text cell, so its meter is shorter.
    const maxMeter = event.surface === 'terminal' ? 18 : 10
    const width = Math.max(6, Math.min(maxMeter, event.props.bodyColumns - 60))
    const weeklyLimit = usage.rateLimits.find(limit => limit.kind === 'seven_day')
    const meterColor = usageColor(percent)
    const contextMeter = meter(percent, width)
    const detailsOpen = event.surface === 'terminal' && await isBreakdownOpen($)

    return (
      <Box flexDirection="column">
        {rest}
        <Box gap={2} alignItems="center" flexWrap="wrap" overflow="hidden">
          <Box gap={1} alignItems="center" flexShrink={1} minWidth={0} overflow="hidden">
            <Text color={branchColor(branchState.kind)} bold>●</Text>
            <Text bold color={branchColor(branchState.kind)} wrap="truncate-middle">
              {branchState.label}
            </Text>
          </Box>
          <Box gap={1} alignItems="center" flexShrink={0}>
            <Text bold>Context</Text>
            <Box flexShrink={1} overflow="hidden">
              <Text color={meterColor}>{contextMeter.filled}</Text>
              <Text color="inactive">{contextMeter.remaining}</Text>
            </Box>
            <Text color={meterColor} bold>{percent}% of {tokenLabel(contextTarget)}</Text>
          </Box>
          {weeklyLimit && (
            <Box flexShrink={0}>
              <Text dimColor>Week {weeklyLimit.percentUsed}%</Text>
            </Box>
          )}
          {!detailsOpen && (
            <Button
              key="context-details"
              label="Details"
              variant="secondary"
              onPress={() => {
                void openBreakdown($, event.surface)
              }}
            />
          )}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, event) => {
    const { Box, Button, Text } = $.ui.resolve(event)
    const current = breakdown
    const isTerminal = event.surface === 'terminal'

    if (!current) {
      return (
        <Box flexDirection="column" gap={1}>
          <Box justifyContent="space-between" alignItems="center" gap={1} overflow="hidden">
            <Text bold wrap="truncate-end">Session Details</Text>
            <Button
              key="refresh-context"
              label={breakdownLoading ? 'Counting' : 'Refresh'}
              hotkey="r"
              variant="secondary"
              onPress={() => {
                void refreshBreakdown($, event.props.bodyColumns)
              }}
            />
          </Box>
          {breakdownError ? (
            <Text color="error">{breakdownError}</Text>
          ) : (
            <Text dimColor>Counting context tokens...</Text>
          )}
        </Box>
      )
    }

    const usedCategories = current.categories
      .filter(category => category.kind === 'used')
      .sort((left, right) => right.tokens - left.tokens)
    const freeTokens = current.categories
      .filter(category => category.kind === 'free')
      .reduce((total, category) => total + category.tokens, 0)
    const bufferTokens = current.categories
      .filter(category => category.kind === 'buffer')
      .reduce((total, category) => total + category.tokens, 0)
    const deferredTokens = current.categories
      .filter(category => category.kind === 'deferred')
      .reduce((total, category) => total + category.tokens, 0)
    const personalPercent = Math.max(
      0,
      Math.round((current.totalTokens / contextTarget) * 100),
    )
    const windowPercent = Math.max(
      0,
      Math.round((current.totalTokens / current.rawMaxTokens) * 100),
    )
    const barWidth = Math.max(12, Math.min(isTerminal ? 28 : 34, event.props.bodyColumns - 8))
    const shortBarWidth = Math.max(10, Math.min(22, event.props.bodyColumns - 20))
    const progressBar = (
      percent: number,
      width: number,
      color: 'success' | 'warning' | 'error' = 'success',
    ) => {
      const progress = meter(percent, width)
      return (
        <Box>
          <Text color={color}>{progress.filled}</Text>
          <Text color="inactive">{progress.remaining}</Text>
        </Box>
      )
    }
    const mcpServers = groupMcpTools(current.mcpTools)
    const rateLimits = detailUsage?.rateLimits.filter(limit => (
      limit.kind === 'five_hour' || limit.kind === 'seven_day'
    )) ?? []
    const mcpLoadedTokens = mcpServers.reduce((total, server) => total + server.loadedTokens, 0)
    const selectedServer = mcpServers.find(server => server.name === selectedMcpServer)
    const maxMcpPage = selectedServer
      ? Math.max(0, Math.ceil(selectedServer.tools.length / MCP_TOOLS_PER_PAGE) - 1)
      : 0
    const visibleMcpPage = Math.min(mcpPage, maxMcpPage)
    const visibleMcpTools = selectedServer?.tools.slice(
      visibleMcpPage * MCP_TOOLS_PER_PAGE,
      (visibleMcpPage + 1) * MCP_TOOLS_PER_PAGE,
    ) ?? []
    const serverPicker = event.surface === 'mobile' ? (
      <Text dimColor>Tool details are available in desktop and terminal.</Text>
    ) : (() => {
      const { Select } = $.ui.resolve(event)
      return (
        <Select
          key="mcp-server-select"
          label="Tool details"
          value={selectedServer?.name ?? ''}
          options={[
            { value: '', label: 'Choose a server' },
            ...mcpServers.map(server => ({
              value: server.name,
              label: `${friendlyName(server.name, 32)} (${server.tools.length})`,
            })),
          ]}
          onSelect={value => {
            selectedMcpServer = value || null
            mcpPage = 0
            $.ui.invalidate('ui.render')
          }}
        />
      )
    })()
    const contextTargetEditor = !editingContextTarget ? null : event.surface === 'mobile' ? (
      <Text dimColor>Change Context target from /config.</Text>
    ) : (() => {
      const { Input } = $.ui.resolve(event)
      return (
        <Box flexDirection="column">
          <Input
            key="context-target-input"
            label="Target"
            value={contextTargetDraft}
            placeholder="300k"
            submitLabel="Save"
            autoFocus
            onInput={value => {
              contextTargetDraft = value
              contextTargetError = ''
            }}
            onSubmit={value => {
              void saveContextTarget($, value)
            }}
          />
          {contextTargetError && <Text color="error">{contextTargetError}</Text>}
        </Box>
      )
    })()

    return (
      <Box key="session-details" flexDirection="column" gap={isTerminal ? 0 : 1}>
        <Box justifyContent="space-between" alignItems="center" gap={1} overflow="hidden">
          <Text bold wrap="truncate-end">Session Details</Text>
          <Button
            key="refresh-context"
            label={breakdownLoading ? 'Counting' : 'Refresh'}
            hotkey="r"
            variant="secondary"
            onPress={() => {
              void refreshBreakdown($, event.props.bodyColumns)
            }}
          />
        </Box>

        <Box
          key="context-summary"
          flexDirection="column"
          gap={isTerminal ? 0 : 1}
          borderStyle="round"
          borderColor={usageColor(personalPercent)}
          paddingX={1}
          overflow="hidden"
        >
          <Box justifyContent="space-between" alignItems="center" gap={1} overflow="hidden">
            <Box gap={1} flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
              <Text color={usageColor(personalPercent)} bold>●</Text>
              <Text bold wrap="truncate-end">
                {detailTokenLabel(current.totalTokens)} used
              </Text>
            </Box>
            <Text color={usageColor(personalPercent)} bold>{personalPercent}%</Text>
          </Box>
          {progressBar(personalPercent, barWidth, usageColor(personalPercent))}
          <Box
            key="context-target-row"
            justifyContent="space-between"
            alignItems="center"
            gap={1}
            overflow="hidden"
          >
            <Text dimColor wrap="truncate-end">
              {targetHeadroomLabel(current.totalTokens, contextTarget)}
            </Text>
            <Box flexShrink={0}>
              <Button
                key="change-context-target"
                label={editingContextTarget ? 'Cancel' : 'Change'}
                variant="secondary"
                onPress={() => {
                  editingContextTarget = !editingContextTarget
                  contextTargetDraft = editingContextTarget ? tokenLabel(contextTarget) : ''
                  contextTargetError = ''
                  $.ui.invalidate('ui.render')
                }}
              />
            </Box>
          </Box>
          {contextTargetEditor}
          <Text dimColor wrap="truncate-end">
            {current.model} · {modelWindowLabel(current.rawMaxTokens)} model window
          </Text>
        </Box>

        <Box
          key="account-usage"
          flexDirection="column"
          gap={isTerminal ? 0 : 1}
          marginTop={isTerminal ? 0 : 1}
        >
          <Text bold>Account usage</Text>
          {rateLimits.length > 0 ? rateLimits.map(limit => (
            <Box key={limit.kind} flexDirection="column">
              <Box justifyContent="space-between" width="100%" gap={1}>
                <Text>{rateLimitTitle(limit)}</Text>
                <Text color={usageColor(limit.percentUsed)} bold>{limit.percentUsed}%</Text>
              </Box>
              {progressBar(limit.percentUsed, barWidth, usageColor(limit.percentUsed))}
              {limit.resetsAt && <Text dimColor>{resetLabel(limit.resetsAt)}</Text>}
            </Box>
          )) : (
            <Text dimColor>Rate-limit usage is not available yet.</Text>
          )}
          {detailUsage?.cost && (
            <Box justifyContent="space-between" width="100%">
              <Text>Session cost</Text>
              <Text dimColor>${detailUsage.cost.usd.toFixed(2)}</Text>
            </Box>
          )}
        </Box>

        <Box flexDirection="column" gap={1}>
          <Text bold>Context makeup</Text>
          {usedCategories.map(category => {
            const share = current.totalTokens > 0
              ? (category.tokens / current.totalTokens) * 100
              : 0

            return (
              <Box key={`${category.kind}:${category.name}`} flexDirection="column">
                <Box justifyContent="space-between" width="100%" gap={1}>
                  <Text wrap="truncate">{category.name}</Text>
                  <Text dimColor>{detailTokenLabel(category.tokens)} · {percentage(category.tokens, current.totalTokens)}</Text>
                </Box>
                {progressBar(share, barWidth)}
              </Box>
            )
          })}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Box justifyContent="space-between" width="100%">
            <Text bold>Model window</Text>
            <Text dimColor>{detailTokenLabel(current.totalTokens)} / {tokenLabel(current.rawMaxTokens)}</Text>
          </Box>
          {progressBar(windowPercent, barWidth, usageColor(windowPercent))}
          <Box gap={2} flexWrap="wrap">
            {freeTokens > 0 && <Text dimColor>Free {detailTokenLabel(freeTokens)}</Text>}
            {bufferTokens > 0 && <Text dimColor>Buffer {detailTokenLabel(bufferTokens)}</Text>}
            {deferredTokens > 0 && <Text dimColor>Deferred {detailTokenLabel(deferredTokens)}</Text>}
          </Box>
        </Box>

        {mcpServers.length > 0 && (
          <Box flexDirection="column" gap={1} marginTop={1}>
            <Box justifyContent="space-between" width="100%">
              <Text bold>MCP servers</Text>
              <Text dimColor>{detailTokenLabel(mcpLoadedTokens)} loaded</Text>
            </Box>

            {mcpServers.slice(0, MCP_SERVER_LIMIT).map(server => {
              const share = mcpLoadedTokens > 0
                ? (server.loadedTokens / mcpLoadedTokens) * 100
                : 0

              return (
                <Box key={`mcp-server-${server.name}`} flexDirection="column">
                  <Box justifyContent="space-between" width="100%" gap={1}>
                    <Text wrap="truncate">{friendlyName(server.name)}</Text>
                    <Text dimColor>
                      {detailTokenLabel(server.loadedTokens)} · {server.loadedTools}/{server.tools.length} tools
                    </Text>
                  </Box>
                  {progressBar(share, barWidth)}
                </Box>
              )
            })}

            {mcpServers.length > MCP_SERVER_LIMIT && (
              <Text dimColor>{mcpServers.length - MCP_SERVER_LIMIT} more servers in the picker</Text>
            )}

            {serverPicker}

            {selectedServer && (
              <Box flexDirection="column" gap={1}>
                <Box justifyContent="space-between" alignItems="center" width="100%">
                  <Text bold>{friendlyName(selectedServer.name)} tools</Text>
                  <Box gap={1}>
                    <Text dimColor>
                      {visibleMcpPage * MCP_TOOLS_PER_PAGE + 1}-{Math.min((visibleMcpPage + 1) * MCP_TOOLS_PER_PAGE, selectedServer.tools.length)} of {selectedServer.tools.length}
                    </Text>
                    {visibleMcpPage > 0 && (
                      <Button
                        key="mcp-previous"
                        label="Previous"
                        plain
                        onPress={() => {
                          mcpPage = Math.max(0, visibleMcpPage - 1)
                          $.ui.invalidate('ui.render')
                        }}
                      />
                    )}
                    {visibleMcpPage < maxMcpPage && (
                      <Button
                        key="mcp-next"
                        label="Next"
                        plain
                        onPress={() => {
                          mcpPage = Math.min(maxMcpPage, visibleMcpPage + 1)
                          $.ui.invalidate('ui.render')
                        }}
                      />
                    )}
                  </Box>
                </Box>

                {visibleMcpTools.map(tool => (
                  <Box key={`${tool.serverName}:${tool.name}`} flexDirection="column">
                    <Box justifyContent="space-between" width="100%" gap={1}>
                      <Text color={tool.isLoaded ? 'success' : 'inactive'} wrap="truncate">
                        {toolName(tool)}
                      </Text>
                      <Text dimColor>
                        {tool.isLoaded ? detailTokenLabel(tool.tokens) : 'deferred'}
                      </Text>
                    </Box>
                    {tool.isLoaded && (
                      progressBar(selectedServer.loadedTokens > 0
                        ? (tool.tokens / selectedServer.loadedTokens) * 100
                        : 0, shortBarWidth)
                    )}
                  </Box>
                ))}

                {selectedServer.deferredTools > 0 && (
                  <Text dimColor>
                    {selectedServer.deferredTools} deferred schemas are outside active context.
                  </Text>
                )}
              </Box>
            )}
          </Box>
        )}

        <Text dimColor>
          Messages is the conversation total. Per-message counts are not available.
        </Text>
        {breakdownError && <Text color="error">Last refresh failed: {breakdownError}</Text>}
      </Box>
    )
  })
}
