import type { PiAgentKind } from '../../shared/pi-agent-kind'

/** Pi owns nested prompt depth and emits one pair around select/confirm/input/editor/custom. */
export function getPiAgentStatusUiPromptHandlerSourceLines(kind: PiAgentKind): string[] {
  if (kind !== 'pi') {
    return []
  }

  return [
    "  pi.on('ui_prompt_start', () => {",
    '    if (isOmpRuntime()) return',
    '    piUiPromptActive = true',
    "    post('ui_prompt_start')",
    '  })',
    '',
    "  pi.on('ui_prompt_end', (_event, ctx) => {",
    '    if (isOmpRuntime() || !piUiPromptActive) return',
    '    // Why: isIdle() throws once the runner is invalidated (a modal that switched',
    "    // sessions). Report 'working' rather than 'done': a skipped post would strand the",
    "    // pane on 'waiting', but a wrong 'done' fires the completion bell for a turn that",
    '    // is still running, and agent_end/agent_settled still delivers the real one.',
    '    let isIdle = false',
    '    try {',
    '      isIdle = ctx?.isIdle?.() === true',
    '    } catch {',
    '      isIdle = false',
    '    }',
    '    piUiPromptActive = false',
    "    post('ui_prompt_end', { is_idle: isIdle })",
    '  })',
    ''
  ]
}
