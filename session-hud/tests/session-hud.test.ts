import { expect, mock, test } from 'claude-code/testing'
import type {
  PaneOpenArgs,
  RenderPropsOf,
  SessionContextBreakdown,
  SessionUsage,
} from 'claude-code'

const PROPS: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 6 },
  view: {},
}

const USAGE: SessionUsage = {
  startedAt: 0,
  context: { tokens: 52_000, window: 200_000, percent: 26 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 37, resetsAt: '2026-10-15T15:00:00Z' },
    { kind: 'seven_day', percentUsed: 64, resetsAt: '2026-10-19T12:00:00Z' },
  ],
  cost: { usd: 1.24 },
}

const BREAKDOWN: SessionContextBreakdown = {
  categories: [
    { name: 'System prompt', tokens: 8_000, color: 'accent', isDeferred: false, kind: 'used' },
    { name: 'MCP tools', tokens: 4_000, color: 'accent', isDeferred: false, kind: 'used' },
    { name: 'Messages', tokens: 40_000, color: 'accent', isDeferred: false, kind: 'used' },
    { name: 'Free space', tokens: 138_000, color: 'inactive', isDeferred: false, kind: 'free' },
    { name: 'Autocompact buffer', tokens: 10_000, color: 'warning', isDeferred: false, kind: 'buffer' },
  ],
  totalTokens: 52_000,
  maxTokens: 1_000_000,
  rawMaxTokens: 1_000_000,
  autocompactSource: 'auto',
  percentage: 26,
  gridRows: [],
  model: 'Opus',
  memoryFiles: [{ path: '/project/CLAUDE.md', type: 'Project', tokens: 1_200 }],
  mcpTools: Array.from({ length: 15 }, (_, index) => ({
    name: `mcp__linear__tool_${String(index + 1).padStart(2, '0')}`,
    serverName: 'linear',
    tokens: 900 - index,
    isLoaded: index < 12,
  })),
  agents: [],
  slashCommands: { totalCommands: 20, includedCommands: 10, tokens: 800 },
  skills: {
    totalSkills: 4,
    includedSkills: 3,
    tokens: 600,
    skillFrontmatter: [{ name: 'review', source: 'plugin', pluginName: 'tools', tokens: 200 }],
  },
  isAutoCompactEnabled: true,
  autoCompactThreshold: 190_000,
  apiUsage: null,
}

const PANE_PROPS: RenderPropsOf['Pane'] = {
  title: 'Session',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

test('shows usage against the configured context maximum on terminal and desktop', async ($, on) => {
  let contextTokens = 52_000
  let branch = 'feature/session-branch-indicator'
  let isGitRepository = true
  let configuredTarget: unknown
  let isDetailsOpen = false
  const opened: PaneOpenArgs[] = []

  const clock = mock.clock(on)
  on('session.usage', () => ({
    value: {
      ...USAGE,
      context: { ...USAGE.context, tokens: contextTokens, breakdown: BREAKDOWN },
    },
  }))
  on('session.start', ($, event) => ({ cwd: event.cwd }))
  on('ui.open', ($, event) => {
    opened.push(event)
    isDetailsOpen = true
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({
    value: isDetailsOpen ? [{
      id: 'context-breakdown',
      title: 'Session',
      isShown: true,
      isFocused: true,
      isPlaced: true,
    }] : [],
  }))
  on('session.cwd', () => ({ value: '/project' }))
  on('process.run', ($, event) => ({
    value: {
      exitCode: isGitRepository ? 0 : 128,
      stdout: event.argv.join(' ') === 'git branch --show-current' ? branch : 'abcdef1',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  on('config.set', ($, event) => {
    configuredTarget = event.value
    return { value: event.value }
  })

  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/project' })

  for (const surface of ['terminal', 'desktop'] as const) {
    contextTokens = 52_000
    isGitRepository = true
    branch = 'feature/session-branch-indicator'
    await $.tool.call({ tool: 'Bash', command: 'git switch feature/session-branch-indicator' })
    const ui = await $.ui.mount({
      plugin: 'session-hud',
      surface,
      component: 'AbovePrompt',
      props: PROPS,
    })

    const featureBranch = await ui.find({ type: 'Text', text: 'feature/session-branch-indicator' })
    if (!featureBranch) throw new Error('The working branch was not rendered')
    expect(featureBranch.props.color).toBe('success')
    expect(await ui.find({ type: 'Text', text: 'Context' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '17% of 300k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Week 64%' })).toBeDefined()
    const detailsButton = await ui.find({ type: 'Button', key: 'context-details' })
    expect(detailsButton?.props).toMatchObject({ label: 'Details', variant: 'secondary' })
    expect(await ui.find({ type: 'Text', text: '$1.24' })).toBeUndefined()
    const meter = await ui.find({ type: 'Text', text: /^█/ })
    expect(meter?.props.color).toBe('success')
    contextTokens = 225_000
    await ui.redraw(PROPS)
    expect((await ui.find({ type: 'Text', text: /^█/ }))?.props.color).toBe('warning')

    contextTokens = 285_000
    await ui.redraw(PROPS)
    expect((await ui.find({ type: 'Text', text: /^█/ }))?.props.color).toBe('error')

    branch = 'main'
    await $.tool.call({ tool: 'Bash', command: 'git switch main' })
    await ui.redraw(PROPS)
    const defaultBranch = await ui.find({ type: 'Text', text: 'main' })
    if (!defaultBranch) throw new Error('The default branch was not rendered')
    expect(defaultBranch.props.color).toBe('warning')

    branch = 'feature/external-switch'
    await clock.advance(5_000)
    await ui.redraw(PROPS)
    const externalBranch = await ui.find({ type: 'Text', text: 'feature/external-switch' })
    if (!externalBranch) throw new Error('The externally changed branch was not rendered')
    expect(externalBranch.props.color).toBe('success')

    branch = ''
    await $.tool.call({ tool: 'Bash', command: 'git switch --detach HEAD' })
    await ui.redraw(PROPS)
    const detachedBranch = await ui.find({ type: 'Text', text: 'detached@abcdef1' })
    if (!detachedBranch) throw new Error('The detached HEAD state was not rendered')
    expect(detachedBranch.props.color).toBe('warning')

    isGitRepository = false
    await $.tool.call({ tool: 'Bash', command: 'cd /tmp' })
    await ui.redraw(PROPS)
    const noBranch = await ui.find({ type: 'Text', text: 'Not a Git repository' })
    if (!noBranch) throw new Error('The non-Git state was not rendered')
    expect(noBranch.props.color).toBe('inactive')

    await ui.press({ key: 'context-details' })
    await ui.redraw(PROPS)
    expect(opened.at(-1)?.columns).toBe(surface === 'terminal' ? 52 : 58)
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Button', key: 'context-details' })).toBeUndefined()
    } else {
      expect(await ui.find({ type: 'Button', key: 'context-details' })).toBeDefined()
    }

    const pane = await $.ui.mount({
      plugin: 'session-hud',
      surface,
      component: 'Pane',
      requestId: 'context-breakdown',
      props: PANE_PROPS,
    })

    expect(await pane.find({ type: 'Text', text: 'Session Details' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '52k used' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '248k until target' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Context makeup' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Opus · 1M model window' })).toBeDefined()
    const sessionDetails = await pane.find({ type: 'Box', key: 'session-details' })
    expect(sessionDetails?.props.gap).toBe(surface === 'terminal' ? 0 : 1)
    const contextSummary = await pane.find({ type: 'Box', key: 'context-summary' })
    expect(contextSummary?.props.gap).toBe(surface === 'terminal' ? 0 : 1)
    const accountUsage = await pane.find({ type: 'Box', key: 'account-usage' })
    expect(accountUsage?.props).toMatchObject({
      gap: surface === 'terminal' ? 0 : 1,
      marginTop: surface === 'terminal' ? 0 : 1,
    })
    const changeTarget = await pane.find({ type: 'Button', key: 'change-context-target' })
    expect(changeTarget?.props).toMatchObject({ label: 'Change', variant: 'secondary' })
    configuredTarget = undefined
    await pane.press({ key: 'change-context-target' })
    expect(await pane.find({ type: 'Input', key: 'context-target-input' })).toBeDefined()
    await pane.input({ key: 'context-target-input', text: 'not a number' })
    expect(configuredTarget).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: 'Enter 10k to 10m, such as 300k or 1m.' }))
      .toBeDefined()
    await pane.input({ key: 'context-target-input', text: '500k' })
    expect(configuredTarget).toBe(500_000)
    expect(await pane.find({ type: 'Text', text: 'Five-hour usage' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Weekly usage' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '64%' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '$1.24' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Messages' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'linear' })).toBeDefined()
    expect(await pane.find({ type: 'Select', key: 'mcp-server-select' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'tool 01' })).toBeUndefined()

    await pane.select({ key: 'mcp-server-select', value: 'linear' })
    const firstTool = await pane.find({ type: 'Text', text: 'tool 01' })
    if (!firstTool) throw new Error('The first MCP tool was not rendered')
    expect(await pane.find({ type: 'Text', text: 'tool 15' })).toBeUndefined()

    await pane.press({ key: 'mcp-next' })
    const lastTool = await pane.find({ type: 'Text', text: 'tool 15' })
    if (!lastTool) throw new Error('The second MCP tool page was not rendered')
    expect(await pane.find({ type: 'Text', text: /Per-message counts are not available/ })).toBeDefined()
    await pane.unmount()
    await ui.unmount()
    isDetailsOpen = false
  }
})

test('uses the saved context target', { options: { context_max_tokens: 200_000 } }, async ($, on) => {
  on('session.usage', () => ({ value: USAGE }))
  on('session.start', ($, event) => ({ cwd: event.cwd }))
  on('session.cwd', () => ({ value: '/project' }))
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: 'main',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))

  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/project' })
  const ui = await $.ui.mount({
    plugin: 'session-hud',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: PROPS,
  })

  expect(await ui.find({ type: 'Text', text: 'Context' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '26% of 200k' })).toBeDefined()
  await ui.unmount()
})

test('clears detailed usage when clear starts a new session', async ($, on) => {
  mock.clock(on)
  on('session.usage', () => ({
    value: {
      ...USAGE,
      context: { ...USAGE.context, breakdown: BREAKDOWN },
    },
  }))
  on('session.start', ($, event) => ({ cwd: event.cwd }))
  on('session.end', ($, event) => ({ sessionId: event.sessionId }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: '/project' }))
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: 'main',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))

  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/project' })
  const band = await $.ui.mount({
    plugin: 'session-hud',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: PROPS,
  })
  await band.press({ key: 'context-details' })

  const pane = await $.ui.mount({
    plugin: 'session-hud',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'context-breakdown',
    props: PANE_PROPS,
  })
  expect(await pane.find({ type: 'Text', text: 'Messages' })).toBeDefined()

  await $.session.end({
    reason: 'clear',
    sessionId: 'session-1',
    resume: { id: 'session-1' },
  })
  await pane.redraw(PANE_PROPS)

  expect(await pane.find({ type: 'Text', text: 'Counting context tokens...' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Messages' })).toBeUndefined()
  await pane.unmount()
  await band.unmount()
})

test('keeps bands other mods draw above the prompt', async ($, on) => {
  on('session.usage', () => ({ value: USAGE }))
  on('session.start', ($, event) => ({ cwd: event.cwd }))
  on('session.cwd', () => ({ value: '/project' }))
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: 'main',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', props: {}, children: ['next: run the tests'] }))

  for (const surface of ['terminal', 'desktop'] as const) {
    await $.session.start({ surface, isInteractive: true, cwd: '/project' })
    const ui = await $.ui.mount({ plugin: 'session-hud', surface, component: 'AbovePrompt', props: PROPS })

    expect(await ui.find({ type: 'Text', text: 'next: run the tests' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Context' })).toBeDefined()
    await ui.unmount()
  }
})
