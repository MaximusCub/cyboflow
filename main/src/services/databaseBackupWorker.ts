/**
 * databaseBackupWorker — worker-thread entry for the heavy half of a backup.
 *
 * WHY A WORKER. `processSnapshot` archives the day's new `raw_events` rows and
 * then VACUUMs the snapshot, both synchronous better-sqlite3 operations over a
 * multi-gigabyte file. Run on the Electron main thread they would block IPC,
 * window lifecycle, and timers for seconds — and the service fires its first
 * tick during app initialisation, so that stall would land squarely on launch.
 * Here it costs the main thread nothing but an awaited message.
 *
 * Failures come back as a message rather than an uncaught exception so the
 * service can fall back to publishing an unprocessed full copy.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { processSnapshot, type ProcessSnapshotOptions, type ProcessSnapshotResult } from './databaseBackupSnapshot';

export type SnapshotWorkerMessage =
  | { ok: true; result: ProcessSnapshotResult }
  | { ok: false; error: string };

try {
  const result = processSnapshot(workerData as ProcessSnapshotOptions);
  parentPort?.postMessage({ ok: true, result } satisfies SnapshotWorkerMessage);
} catch (err) {
  parentPort?.postMessage({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  } satisfies SnapshotWorkerMessage);
}
