/**
 * trackerSync/provenance — the marker an IMPORTED idea carries in its body.
 *
 * Its own module because BOTH directions need it and they sit on opposite sides
 * of an import edge: inboundSync.ts writes the marker (it is the import's crash
 * recovery key — see that file's IMPORT RECOVERY note) and reads it back, while
 * writeBack.ts must recognize it to keep the PUSH direction from filing a fresh
 * tracker issue for an idea the tracker itself just gave us. inboundSync already
 * imports from writeBack, so exporting it from either of them would close a
 * cycle.
 */
import type { TrackerProvider } from '../../../../shared/types/trackerSync';

/** Machine-recognizable marker prefix so the footer can be split back off a body. */
export const PROVENANCE_MARKER_PREFIX = '<!-- cyboflow:tracker';

/**
 * The marker an imported idea's footer opens with. It embeds the issue's
 * `(provider, externalId)` because this is the IMPORT'S RECOVERY KEY: the
 * marker is written in the same statement as the idea, so it is the only
 * durable trace of an import whose link write never happened.
 */
export function provenanceMarker(provider: TrackerProvider, externalId: string): string {
  return `${PROVENANCE_MARKER_PREFIX} ${provider}:${externalId} -->`;
}

/**
 * True when a body carries ANY tracker-import provenance marker — "this idea
 * came FROM a tracker", whichever provider and issue it names.
 *
 * The push direction's third skip case. The actor check ahead of it already
 * catches the ordinary import (inbound applies its writes as `actor: 'linear' |
 * 'plane'`), but an event with no actor at all is merely unattributed, not
 * local — and pushing on one would file a second issue for an issue we are
 * already synced to.
 */
export function carriesTrackerProvenance(body: string | null): boolean {
  return body !== null && body.includes(PROVENANCE_MARKER_PREFIX);
}
