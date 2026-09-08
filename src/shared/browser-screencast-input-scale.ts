import type { BrowserScreencastFrameMetadata } from './browser-screencast-protocol'

export function browserScreencastPageScale(
  metadata: Pick<BrowserScreencastFrameMetadata, 'pageScaleFactor'> | null
): number {
  const scale = metadata?.pageScaleFactor
  return typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? scale : 1
}
