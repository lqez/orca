import type { PiAgentKind } from '../../shared/pi-agent-kind'

/** Mirrors the titlebar extension's dialog tracking so both agree on when the wait ends. */
export function getPiAgentStatusUiPromptHandlerSourceLines(kind: PiAgentKind): string[] {
  if (kind !== 'pi') {
    return []
  }

  return [
    "  pi.on('ui_prompt_start', () => {",
    '    if (isOmpRuntime()) return',
    '    piUiPromptDepth++',
    '    if (piUiPromptDepth > 1) return',
    "    post('ui_prompt_start')",
    '  })',
    '',
    "  pi.on('ui_prompt_end', (_event, ctx) => {",
    '    if (isOmpRuntime() || piUiPromptDepth === 0) return',
    '    piUiPromptDepth--',
    '    if (piUiPromptDepth > 0) return',
    '    // Why: ctx.isIdle is undocumented for these events and throws outright once a',
    '    // session-switching modal invalidates the runner, so fall back to what this',
    '    // process already knows: a turn that reported its end is not still running.',
    '    // Guessing working instead would strand an idle pane, since no later event is',
    '    // coming to correct it.',
    '    let isIdle = agentEndReported',
    '    try {',
    "      if (typeof ctx?.isIdle === 'function') isIdle = ctx.isIdle() === true",
    '    } catch {',
    '      isIdle = agentEndReported',
    '    }',
    "    post('ui_prompt_end', { is_idle: isIdle })",
    '  })',
    ''
  ]
}
