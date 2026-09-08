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
    '    let isIdle = false',
    '    let idleUnknown = false',
    '    try {',
    '      isIdle = ctx?.isIdle?.() === true',
    '    } catch {',
    '      idleUnknown = true',
    '    }',
    '    // Why: isIdle() throws once the runner is invalidated (a modal that switched',
    "    // sessions). 'done' would ring the completion bell for a turn that may still be",
    "    // running, so report 'working' — but the last turn already reported its end, so",
    '    // also re-arm that report or nothing would ever move the pane off working.',
    '    if (idleUnknown) agentEndReported = false',
    "    post('ui_prompt_end', { is_idle: isIdle })",
    '  })',
    ''
  ]
}
