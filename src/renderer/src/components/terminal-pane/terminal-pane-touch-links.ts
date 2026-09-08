import type { IDisposable, Terminal } from '@xterm/xterm'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import type { LinkHandlerDeps } from './terminal-link-handlers'
import type { TerminalLinkActionContext } from './terminal-link-action-request'
import { openFilePathLinkAtBufferPosition } from './terminal-file-link-hit-testing'
import { handleTerminalFileLink } from './terminal-file-link-actions'
import { getTerminalBufferPositionForMouseEvent } from './terminal-mouse-buffer-position'
import { handleOscLink } from './terminal-osc-link-routing'
import { installTerminalLinkTouchGesture } from './terminal-link-touch-gesture'
import {
  findHttpLinkAtTerminalMouseEvent,
  handleTerminalHttpLink,
  type TerminalHttpLinkActionDestinations,
  type TerminalLinkRoutingPreferenceRequester
} from './terminal-url-link-hit-testing'

// Same guarded OSC 8 lookup as the mobile WebView; labels need not contain their URI.
function oscLinkAtPosition(terminal: Terminal, position: { x: number; y: number }): string | null {
  try {
    const cell = terminal.buffer.active.getLine(position.y - 1)?.getCell(position.x - 1) as
      | { extended?: { urlId?: number } }
      | undefined
    const core = (
      terminal as unknown as {
        _core?: { _oscLinkService?: { getLinkData: (id: number) => { uri?: string } | undefined } }
      }
    )._core
    return cell?.extended?.urlId
      ? (core?._oscLinkService?.getLinkData(cell.extended.urlId)?.uri ?? null)
      : null
  } catch {
    return null
  }
}

export function installTerminalPaneTouchLinks({
  terminal,
  paneId,
  linkDeps,
  getLinkActionContext,
  getSourceOwner,
  getActionDestinations,
  requestOpenLinksInAppPreference
}: {
  terminal: Terminal
  paneId: number
  linkDeps: LinkHandlerDeps
  getLinkActionContext: () => TerminalLinkActionContext | null
  getSourceOwner: () => HttpLinkSourceOwner
  getActionDestinations: () => TerminalHttpLinkActionDestinations
  requestOpenLinksInAppPreference: TerminalLinkRoutingPreferenceRequester
}): IDisposable {
  return installTerminalLinkTouchGesture(terminal, ({ x, y }) => {
    const context = getLinkActionContext()
    if (!context) {
      return false
    }
    const event = new MouseEvent('click', { clientX: x, clientY: y, button: 0, cancelable: true })
    const position = getTerminalBufferPositionForMouseEvent(terminal, event)
    if (!position) {
      return false
    }
    // The touch recognizer already checked selection/drag; no PTY mouse input was dispatched.
    const linkActionContext: TerminalLinkActionContext = {
      ...context,
      pointerGesture: { canRequestAction: () => true, dispose: () => {} },
      claimPtyMouse: () => true
    }
    const deps = {
      ...linkDeps,
      startupCwd: linkDeps.getPaneLinkCwd?.(paneId) ?? linkDeps.startupCwd,
      runtimeEnvironmentId:
        linkDeps.getRuntimeEnvironmentIdForPane?.(paneId) ?? linkDeps.runtimeEnvironmentId ?? null,
      sourceOwner: getSourceOwner(),
      actionDestinations: getActionDestinations(),
      requestOpenLinksInAppPreference,
      linkActionContext
    }
    const oscLink = oscLinkAtPosition(terminal, position)
    if (oscLink) {
      return handleOscLink(oscLink, event, deps)
    }
    const url = findHttpLinkAtTerminalMouseEvent(terminal, event)
    if (url) {
      return handleTerminalHttpLink(url, event, deps)
    }
    return openFilePathLinkAtBufferPosition(terminal.buffer.active, position, terminal.cols, {
      ...deps,
      activate: (path, line, column) =>
        handleTerminalFileLink(path, line, column, event, deps, linkActionContext)
    })
  })
}
