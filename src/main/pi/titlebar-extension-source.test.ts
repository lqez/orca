import { runInNewContext } from 'node:vm'
// TypeScript 7 is a native CLI; transpile tests still need the legacy JavaScript API.
import ts from 'typescript-api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { detectAgentStatusFromTitle } from '../../shared/agent-detection'
import type { PiAgentKind } from '../../shared/pi-agent-kind'
import { getPiTitlebarExtensionSource } from './titlebar-extension-source'

const BRAILLE_RE = /[⠀-⣿]/

type TitlebarContext = {
  ui: { setTitle: (title: string) => void }
  isIdle?: () => boolean
}
type HookHandler = (event?: unknown, context?: TitlebarContext) => Promise<void> | void

type Harness = {
  handlers: Record<string, HookHandler>
  titles: string[]
  lastTitle: () => string | undefined
  callHook: (name: string, event?: unknown) => Promise<void>
}

const CWD = '/repo/orca-app'
const SESSION = 'omp-session'
const IDLE_TITLE = `π - ${SESSION} - orca-app`
const PROMPT_TITLE = `π ! ${SESSION} - orca-app`

function createHarness(
  options: {
    paneKey?: string
    isIdle?: () => boolean
    kind?: PiAgentKind
    processTitle?: string
  } = {}
): Harness {
  const titles: string[] = []
  const ctx: TitlebarContext = {
    ui: {
      setTitle: (title: string) => {
        titles.push(title)
      }
    },
    isIdle: options.isIdle
  }

  const module = {
    exports: {} as {
      default?: (pi: {
        on: (name: string, handler: HookHandler) => void
        getSessionName: () => string
      }) => void
    }
  }

  const context = {
    module,
    exports: module.exports,
    process: {
      env: { ORCA_PANE_KEY: options.paneKey ?? 'pane-1' },
      title: options.processTitle ?? 'pi',
      argv: ['node', 'pi'],
      cwd: () => CWD
    },
    console: { warn: vi.fn(), error: vi.fn(), log: vi.fn() },
    Promise,
    // Why: forward to the test realm's timers so vi.useFakeTimers() drives the VM's interval.
    setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
    clearInterval: (timer: ReturnType<typeof setInterval>) => clearInterval(timer),
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer)
  } as Record<string, unknown>
  context.globalThis = context

  const output = ts.transpileModule(getPiTitlebarExtensionSource(options.kind ?? 'pi'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText
  runInNewContext(output, context)

  const register = module.exports.default
  if (!register) {
    throw new Error('expected default export from generated source')
  }

  const handlers: Record<string, HookHandler> = {}
  register({
    on(name: string, handler: HookHandler) {
      handlers[name] = handler
    },
    getSessionName: () => SESSION
  })

  return {
    handlers,
    titles,
    lastTitle: () => titles.at(-1),
    callHook: async (name, event) => {
      const handler = handlers[name]
      if (!handler) {
        throw new Error(`no handler registered for ${name}`)
      }
      await handler(event, ctx)
    }
  }
}

describe('getPiTitlebarExtensionSource', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('registers nothing outside an Orca pane', () => {
    expect(createHarness({ paneKey: '' }).handlers).toEqual({})
  })

  it('stops the spinner when the agent settles', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    expect(vi.getTimerCount()).toBe(1)

    await harness.callHook('agent_settled')

    expect(vi.getTimerCount()).toBe(0)
    expect(harness.lastTitle()).toBe(IDLE_TITLE)
    expect(harness.lastTitle()).not.toMatch(BRAILLE_RE)

    const titleCountAtSettle = harness.titles.length
    vi.advanceTimersByTime(800)
    expect(harness.titles.length).toBe(titleCountAtSettle)
  })

  it('spins for idle auto-compaction and clears it on completion', async () => {
    const harness = createHarness()

    await harness.callHook('auto_compaction_start', { reason: 'idle' })
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(80)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)

    await harness.callHook('auto_compaction_end', { reason: 'idle' })

    expect(vi.getTimerCount()).toBe(0)
    expect(harness.lastTitle()).toBe(IDLE_TITLE)
  })

  it('caps the idle-maintenance spinner when no completion event arrives', async () => {
    const harness = createHarness()

    await harness.callHook('auto_compaction_start', { reason: 'idle' })
    // Just past the ~5-minute cap; the guard is checked at the top of the next frame.
    vi.advanceTimersByTime(301_000)

    expect(vi.getTimerCount()).toBe(0)
    expect(harness.lastTitle()).toBe(IDLE_TITLE)
  })

  it('does not cap an agent-owned spinner', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    vi.advanceTimersByTime(301_000)

    expect(vi.getTimerCount()).toBe(1)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
  })

  it('keeps spinning through threshold compaction inside an active run', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    await harness.callHook('auto_compaction_start', { reason: 'threshold' })
    await harness.callHook('auto_compaction_end', { reason: 'threshold' })

    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(80)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
  })

  it('does not let an idle compaction adopt an already-running agent spinner', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    await harness.callHook('auto_compaction_start', { reason: 'idle' })
    await harness.callHook('auto_compaction_end', { reason: 'idle' })

    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(80)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
  })

  it('does not let a stale idle-compaction completion stop a newer run', async () => {
    const harness = createHarness()

    await harness.callHook('auto_compaction_start', { reason: 'idle' })
    await harness.callHook('agent_start')
    await harness.callHook('auto_compaction_end', { reason: 'idle' })

    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(80)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
  })

  it('transfers an idle-compaction spinner to a new run without publishing idle', async () => {
    const harness = createHarness()

    await harness.callHook('auto_compaction_start', { reason: 'idle' })
    vi.advanceTimersByTime(80)
    const titleCountBeforeTransfer = harness.titles.length

    await harness.callHook('agent_start')

    const transferTitles = harness.titles.slice(titleCountBeforeTransfer)
    expect(transferTitles).not.toContain(IDLE_TITLE)
    expect(transferTitles).toHaveLength(1)
    expect(transferTitles[0]).toMatch(BRAILLE_RE)
  })

  it('keeps spinning across a non-terminal OMP agent_end', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    await harness.callHook('agent_end', { willContinue: true })

    expect(vi.getTimerCount()).toBe(1)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
  })

  it('waits for modern runtimes to become idle after agent_end', async () => {
    let idle = false
    const harness = createHarness({ isIdle: () => idle })

    await harness.callHook('agent_start')
    await harness.callHook('agent_end')
    await vi.advanceTimersByTimeAsync(100)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)

    idle = true
    await vi.advanceTimersByTimeAsync(200)
    expect(vi.getTimerCount()).toBe(0)
    expect(harness.lastTitle()).toBe(IDLE_TITLE)
  })

  it('still stops on legacy agent_end and on session shutdown', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    await harness.callHook('agent_end')
    expect(vi.getTimerCount()).toBe(0)
    expect(harness.lastTitle()).toBe(IDLE_TITLE)

    await harness.callHook('agent_start')
    await harness.callHook('session_shutdown')
    expect(vi.getTimerCount()).toBe(0)
    expect(harness.lastTitle()).toBe(IDLE_TITLE)
  })

  it('marks a mid-turn dialog as needing input and holds it against the spinner', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    await harness.callHook('ui_prompt_start')
    expect(harness.lastTitle()).toBe(PROMPT_TITLE)
    expect(detectAgentStatusFromTitle(PROMPT_TITLE)).toBe('permission')

    // Why: the spinner interval keeps running, but must not repaint over the marker.
    await vi.advanceTimersByTimeAsync(800)
    expect(harness.lastTitle()).toBe(PROMPT_TITLE)

    await harness.callHook('ui_prompt_end')
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('returns an idle pane to its plain title when the dialog closes', async () => {
    const harness = createHarness()

    await harness.callHook('ui_prompt_start')
    expect(harness.lastTitle()).toBe(PROMPT_TITLE)

    await harness.callHook('ui_prompt_end')
    expect(harness.lastTitle()).toBe(IDLE_TITLE)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('only the outermost of nested dialogs moves the title', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    await harness.callHook('ui_prompt_start')
    await harness.callHook('ui_prompt_start')
    await harness.callHook('ui_prompt_end')
    // Why: the outer dialog still holds input focus.
    expect(harness.lastTitle()).toBe(PROMPT_TITLE)

    await harness.callHook('ui_prompt_end')
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
  })

  it('ignores an unmatched dialog close', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    const titleCount = harness.titles.length
    await harness.callHook('ui_prompt_end')
    expect(harness.titles.length).toBe(titleCount)
  })

  it.each(['agent_settled', 'session_shutdown'])(
    'keeps the marker when %s lands under an open dialog',
    async (name) => {
      const harness = createHarness()

      await harness.callHook('agent_start')
      await harness.callHook('ui_prompt_start')
      await harness.callHook(name)
      // Why: settling does not answer the dialog, so the pane still needs the user.
      const expected = name === 'session_shutdown' ? IDLE_TITLE : PROMPT_TITLE
      expect(harness.lastTitle()).toBe(expected)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('keeps the marker across an idle compaction that finishes under a dialog', async () => {
    const harness = createHarness()

    await harness.callHook('ui_prompt_start')
    await harness.callHook('auto_compaction_start', { reason: 'idle' })
    await harness.callHook('auto_compaction_end')
    expect(harness.lastTitle()).toBe(PROMPT_TITLE)
  })

  it('recovers the spinner on a new turn when a dialog close was lost', async () => {
    const harness = createHarness()

    await harness.callHook('ui_prompt_start')
    expect(harness.lastTitle()).toBe(PROMPT_TITLE)

    // Why: a turn cannot start under a dialog holding input focus, so this is recovery.
    await harness.callHook('agent_start')
    await vi.advanceTimersByTimeAsync(80)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
  })

  it('leaves the marker to OMP approval events instead of painting it', () => {
    expect(createHarness({ kind: 'omp' }).handlers.ui_prompt_start).toBeUndefined()
  })

  it('still caps idle maintenance while a dialog holds the title', async () => {
    const harness = createHarness()

    await harness.callHook('auto_compaction_start', { reason: 'idle' })
    await harness.callHook('ui_prompt_start')
    // Why: an open dialog must not suspend the cap that stops a stranded spinner.
    vi.advanceTimersByTime(301_000)

    expect(vi.getTimerCount()).toBe(0)
    expect(harness.lastTitle()).toBe(PROMPT_TITLE)
  })

  it('survives a dialog event that carries no ui context', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    await expect(harness.handlers.ui_prompt_start?.({}, undefined)).resolves.toBeUndefined()
    await expect(harness.handlers.ui_prompt_end?.({}, undefined)).resolves.toBeUndefined()
  })

  it('keeps spinning when the dialog event could not paint the marker', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    await harness.handlers.ui_prompt_start?.({}, undefined)
    // Why: suppressing frames without a marker would freeze the title mid-spinner, which
    // still reads as working — the opposite of what the marker is for.
    await vi.advanceTimersByTimeAsync(160)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
  })

  it('leaves an OMP runtime to its own approval events', () => {
    const harness = createHarness({ processTitle: 'omp' })

    expect(harness.handlers.ui_prompt_start).toBeDefined()
    expect(() => harness.handlers.ui_prompt_start?.({}, undefined)).not.toThrow()
  })
})
