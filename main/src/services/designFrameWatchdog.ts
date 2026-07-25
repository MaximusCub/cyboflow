/**
 * DesignFrameWatchdog (Design Mode v1 — design-mode.md "Process isolation" +
 * "Isolation spike results (rev 7)") — the main-process metrics-polling watchdog
 * that SIGKILLs a runaway interactive-prototype frame WITHOUT wedging the host UI.
 *
 * WHY POLLING (spike finding 5): the interactive canvas renders in a genuinely
 * cross-origin loopback-origin frame, so it gets its OWN OOPIF renderer process —
 * an accidental/adversarial busy-loop or memory bomb in prototype JS pegs THAT
 * process, not the host. But Electron emits NEITHER `render-process-gone` NOR
 * `child-process-gone` for an OOPIF process death, so there is no event to hang a
 * detector on: the only signals are (a) the pid vanishing from
 * `app.getAppMetrics()` and (b) the frame's `WebFrameMain` throwing
 * "Render frame was disposed" on ANY property access. The watchdog is the killer
 * in the designed flow (so it always knows its own kills); polling is what also
 * catches spontaneous deaths (OS OOM). Every frame-property read is therefore
 * wrapped in a disposal guard — a disposed frame must degrade the poll, never
 * throw out of it.
 *
 * WHY THE THRESHOLDS ARE SHAPED THIS WAY (spike finding 4):
 *   - `percentCPUUsage` is DELTA-BASED — the first sample for a pid reads 0, so a
 *     just-spawned frame never trips CPU on its first poll (0 < the threshold);
 *   - it is MACHINE-NORMALIZED — a fully pegged core reads ≈ 100/os.cpus().length,
 *     so we convert to a machine-independent "pegged fraction of one core"
 *     (`cpu * cpuCount / 100`) and act on "sustained ≈ one core", not a fixed %.
 * Memory rides the same channel (`workingSetSize`, reported in KB) and is an
 * ABSOLUTE reading, so a 2-consecutive-sample rule is enough to debounce a spike.
 *
 * ELECTRON-FREE by construction: every host interaction (frame enumeration,
 * metrics, kill, renderer push, cpu count) is a constructor seam, so the poll
 * logic (matching, streak accounting, kill guards) unit-tests with plain fakes
 * and no Electron import. index.ts wires the concrete Electron-backed seams.
 */
import type { LoggerLike } from '../orchestrator/types';
import {
  DESIGN_PROTO_SERVER_EVENT_CHANNEL,
  type PrototypeFrameTerminationReason,
  type PrototypeServerEvent,
} from '../../../shared/types/designPrototypeServer';

/** Re-export so index.ts can name the channel from one place when wiring the seam. */
export { DESIGN_PROTO_SERVER_EVENT_CHANNEL };

/**
 * The narrow frame surface the watchdog reads. Mirrors the subset of Electron's
 * `WebFrameMain` the watchdog touches — declared locally so this module stays
 * Electron-free. CRITICAL: BOTH property reads can THROW ("Render frame was
 * disposed") on a killed frame, so the watchdog only ever accesses them behind a
 * try/catch (see {@link safeRead}); the interface is intentionally shaped as
 * plain properties so a test can back them with throwing getters.
 */
export interface FrameLike {
  readonly url: string;
  readonly osProcessId: number;
}

/** One registered prototype server the watchdog judges frames against. */
export interface WatchdogTarget {
  /** `http://127.0.0.1:<port>` — a frame whose url starts with this is a candidate. */
  origin: string;
  /** The run the origin's server belongs to — stamped onto the emitted event. */
  runId: string;
}

/** One process's metrics, normalized off `app.getAppMetrics()` by the seam. */
export interface ProcessMetricSample {
  pid: number;
  /** `cpu.percentCPUUsage` — delta-based, machine-normalized (see header). */
  percentCPUUsage: number;
  /** `memory.workingSetSize`, in KB (Electron's unit). */
  workingSetSizeKB: number;
}

/** The control surface DesignPrototypeServerManager drives (start on first server, stop on last). */
export interface FrameWatchdogControl {
  start(): void;
  stop(): void;
}

export interface DesignFrameWatchdogOptions {
  /** Live registered servers to judge frames against (read every poll). */
  getTargets: () => ReadonlyArray<WatchdogTarget>;
  /** Enumerate the host window's frame subtree; MUST return [] (never throw) on a disposed/absent window. */
  getFrames: () => ReadonlyArray<FrameLike>;
  /** Per-process metrics, normalized off `app.getAppMetrics()`. */
  getMetrics: () => ReadonlyArray<ProcessMetricSample>;
  /** SIGKILL a pid. May throw (already-dead pid) — the watchdog guards the call. */
  killPid: (pid: number) => void;
  /** Push a watchdog event to the renderer (fail-soft when the window is gone). */
  sendToRenderer: (event: PrototypeServerEvent) => void;
  /** `os.cpus().length` — the machine-normalization divisor (floored to ≥1 by the ctor). */
  cpuCount: number;
  /** The main process pid — never killed. Defaults to `process.pid`. */
  mainProcessPid?: number;
  /** Poll cadence; defaults to 2000ms (spike used ~2s). */
  pollIntervalMs?: number;
  logger?: LoggerLike;
}

/** peggedFraction ≥ this for {@link CPU_KILL_STREAK} consecutive samples → CPU kill. */
const CPU_PEGGED_FRACTION = 0.85;
/** Consecutive hot CPU samples required (~6s at a 2s cadence). */
const CPU_KILL_STREAK = 3;
/** workingSetSize above this (KB = 1.5 GiB) for {@link MEM_KILL_STREAK} samples → memory kill. */
const MEM_MAX_WORKING_SET_KB = 1.5 * 1024 * 1024;
/** Consecutive over-limit memory samples required. */
const MEM_KILL_STREAK = 2;

/** Per-pid consecutive-breach accounting, pruned when a pid stops being a candidate. */
interface StreakState {
  cpu: number;
  mem: number;
}

export class DesignFrameWatchdog implements FrameWatchdogControl {
  private readonly opts: DesignFrameWatchdogOptions;
  private readonly cpuCount: number;
  private readonly mainProcessPid: number;
  private readonly pollIntervalMs: number;
  private readonly logger?: LoggerLike;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Consecutive-breach counters, keyed by candidate frame pid. */
  private readonly streaks = new Map<number, StreakState>();

  constructor(opts: DesignFrameWatchdogOptions) {
    this.opts = opts;
    // A pegged-core fraction is meaningless with a zero divisor; floor to 1.
    this.cpuCount = Math.max(1, Math.floor(opts.cpuCount) || 1);
    this.mainProcessPid = opts.mainProcessPid ?? process.pid;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.logger = opts.logger;
  }

  /** Begin polling (idempotent — a second start while running is a no-op). */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
    // Do not keep the process alive solely for the watchdog timer.
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.logger?.debug('[DesignFrameWatchdog] polling started', { pollIntervalMs: this.pollIntervalMs });
  }

  /** Stop polling and drop all streak state (idempotent). */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.streaks.clear();
    this.logger?.debug('[DesignFrameWatchdog] polling stopped');
  }

  /**
   * One poll pass — public so unit tests can drive it deterministically without
   * timers. Never throws: a disposed frame, an absent window, or a metrics gap
   * degrades this pass, it does not abort the watchdog.
   */
  poll(): void {
    const targets = this.opts.getTargets();
    if (targets.length === 0) {
      // Nothing registered — keep no stale streaks around.
      this.streaks.clear();
      return;
    }

    let frames: ReadonlyArray<FrameLike>;
    try {
      frames = this.opts.getFrames();
    } catch (err) {
      // The seam should already swallow this, but never let the poll throw.
      this.logger?.debug('[DesignFrameWatchdog] getFrames threw — skipping pass', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Partition frames into candidates (a prototype origin) and protected pids
    // (everything else, e.g. the host app frame) — reading url/osProcessId behind
    // a disposal guard. A frame that throws on ANY access is skipped entirely.
    const candidates = new Map<number, string>(); // pid -> runId
    const protectedPids = new Set<number>([this.mainProcessPid]);
    for (const frame of frames) {
      const url = safeRead(() => frame.url);
      const pid = safeRead(() => frame.osProcessId);
      if (url === null || pid === null) continue; // disposed / unreadable
      const target = targets.find((t) => url === t.origin || url.startsWith(t.origin + '/'));
      if (target && !protectedPids.has(pid)) {
        candidates.set(pid, target.runId);
      } else {
        // A non-prototype frame (host app frame, other sub-frames) — its pid is
        // never a kill target, even if it somehow collides with a candidate.
        protectedPids.add(pid);
        candidates.delete(pid);
      }
    }

    // Prune streak state for pids that are no longer candidates (frame gone /
    // respawned under a new pid) so a stale counter can't carry across.
    for (const pid of [...this.streaks.keys()]) {
      if (!candidates.has(pid)) this.streaks.delete(pid);
    }

    if (candidates.size === 0) return;

    const metricByPid = new Map<number, ProcessMetricSample>();
    for (const m of this.opts.getMetrics()) metricByPid.set(m.pid, m);

    for (const [pid, runId] of candidates) {
      const metric = metricByPid.get(pid);
      if (!metric) {
        // Candidate frame with no metrics row this pass — likely just spawned or
        // just died; reset its streaks and wait for a reading.
        this.streaks.delete(pid);
        continue;
      }

      const streak = this.streaks.get(pid) ?? { cpu: 0, mem: 0 };
      // CPU: convert the machine-normalized reading to "fraction of one pegged
      // core". The delta-based first sample reads 0 → below threshold → resets.
      const peggedFraction = (metric.percentCPUUsage * this.cpuCount) / 100;
      streak.cpu = peggedFraction >= CPU_PEGGED_FRACTION ? streak.cpu + 1 : 0;
      streak.mem = metric.workingSetSizeKB > MEM_MAX_WORKING_SET_KB ? streak.mem + 1 : 0;
      this.streaks.set(pid, streak);

      const reason = this.reasonToKill(streak);
      if (reason !== null) {
        this.terminate(pid, runId, reason);
      }
    }
  }

  /** Which breach (if any) has reached its consecutive-sample threshold. CPU wins ties. */
  private reasonToKill(streak: StreakState): PrototypeFrameTerminationReason | null {
    if (streak.cpu >= CPU_KILL_STREAK) return 'cpu';
    if (streak.mem >= MEM_KILL_STREAK) return 'memory';
    return null;
  }

  /**
   * SIGKILL the runaway frame's process and notify the renderer. The SERVER
   * stays up — respawn is the renderer re-setting the iframe src (spike finding
   * 3). Fail-soft: a throwing kill (pid already gone) is logged, and the streak
   * state is dropped so a vanished pid is not re-killed on the next pass.
   */
  private terminate(pid: number, runId: string, reason: PrototypeFrameTerminationReason): void {
    // Defense in depth over the candidate/protected partition: never signal the
    // init process or the main process.
    if (pid <= 1 || pid === this.mainProcessPid) {
      this.streaks.delete(pid);
      return;
    }
    try {
      this.opts.killPid(pid);
      this.logger?.warn('[DesignFrameWatchdog] terminated runaway prototype frame', {
        runId,
        pid,
        reason,
      });
    } catch (err) {
      this.logger?.debug('[DesignFrameWatchdog] kill failed (already gone?) — continuing', {
        pid,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // Whether the kill landed or the pid was already gone, stop tracking it.
      this.streaks.delete(pid);
    }
    try {
      this.opts.sendToRenderer({ runId, kind: 'frame-terminated', reason });
    } catch (err) {
      this.logger?.debug('[DesignFrameWatchdog] renderer notify failed (window gone?)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Read a value behind a disposal guard: a throwing access (disposed frame) → null. */
function safeRead<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}
