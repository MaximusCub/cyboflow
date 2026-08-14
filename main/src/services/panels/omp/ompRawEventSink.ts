import type Database from 'better-sqlite3';
import type { Logger } from '../../../utils/logger';
import { perfBump } from '../../perfTracer';
import type { OmpRpcEvent } from './rpc';

/**
 * ompRawEventSink — the audit trail of an `omp --mode rpc` session, mirroring
 * `CodexRawNotificationSink` onto the same `raw_events` table seam.
 *
 * Persists the NORMALIZED event rather than the wire frame, because that is what
 * the transport hands to listeners (`OmpRpcClient.onEvent`). The normalization is
 * lossless for everything this contract models and carries anything it does not
 * verbatim under the `__unknown__` variant's `frame`, so nothing anomalous is
 * silently dropped — see `rpc/ompContract.ts`.
 */
export const OMP_RAW_EVENT_TYPE = 'omp_rpc_event';

/**
 * Event types never persisted, for the reason the Codex sink skips its two delta
 * methods: they exist only to paint a live UI and are re-delivered in full.
 *
 * `message_update` is the per-token delta stream, superseded by the `message_end`
 * that carries the same message complete. `available_commands_update` is OMP's
 * whole slash-command catalogue (rpc.md:517-522) re-broadcast unsolicited — large
 * and frequent, with nothing run-specific in it. The Codex equivalents were
 * measured at ~161 MB of one production `raw_events` table.
 */
const NON_PERSISTED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'message_update',
  'available_commands_update',
]);

export class OmpRawEventSink {
  private readonly insertStmt: Database.Statement;

  constructor(
    private readonly db: Database.Database,
    private readonly logger?: Logger,
  ) {
    // Prepared once at construction (better-sqlite3 best practice, matching
    // RawEventsSink / CodexRawNotificationSink): `persist` runs synchronously on
    // the main thread for every event of an active turn.
    this.insertStmt = this.db.prepare(
      `INSERT INTO raw_events (run_id, event_type, payload_json, created_at)
       VALUES (?, ?, ?, ?)`,
    );
  }

  persist(runId: string, event: OmpRpcEvent): void {
    if (NON_PERSISTED_EVENT_TYPES.has(event.type)) return;
    perfBump('raw.omp');
    try {
      this.insertStmt.run(
        runId,
        OMP_RAW_EVENT_TYPE,
        JSON.stringify(event),
        new Date().toISOString(),
      );
    } catch (error) {
      this.logger?.warn(
        `[OmpRawEventSink] failed to persist ${event.type} for run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
