/**
 * Unit tests for DesignFrameWatchdog — the runaway interactive-prototype-frame
 * killer. Every host interaction is an injected seam, so these tests drive the
 * poll logic (origin matching, delta-based/machine-normalized CPU accounting,
 * consecutive-sample streaks, disposal guards, kill guards) with plain fakes and
 * NO Electron. poll() is driven directly (no timers).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  DesignFrameWatchdog,
  type FrameLike,
  type ProcessMetricSample,
  type WatchdogTarget,
} from '../designFrameWatchdog';

const ORIGIN = 'http://127.0.0.1:9000';
const RUN_ID = 'run-1';
const FRAME_PID = 4242;
const CPU_COUNT = 10;

/** A candidate frame served from the registered prototype origin. */
function candidateFrame(pid = FRAME_PID): FrameLike {
  return { url: `${ORIGIN}/abc123/prototype/index.html`, osProcessId: pid };
}

/** cpu.percentCPUUsage that reads as a fully-pegged core given CPU_COUNT (>= 0.85 fraction). */
const HOT_CPU = 10; // 10 * 10 / 100 = 1.0 pegged
const COOL_CPU = 1; // 1 * 10 / 100 = 0.1
const HOT_MEM_KB = 2_000_000; // > 1.5 GiB (1_572_864 KB)
const COOL_MEM_KB = 50_000;

interface Harness {
  watchdog: DesignFrameWatchdog;
  killPid: ReturnType<typeof vi.fn>;
  sendToRenderer: ReturnType<typeof vi.fn>;
  setFrames: (frames: FrameLike[]) => void;
  setMetrics: (metrics: ProcessMetricSample[]) => void;
}

function makeHarness(opts?: {
  targets?: WatchdogTarget[];
  mainProcessPid?: number;
  getFrames?: () => FrameLike[];
}): Harness {
  let frames: FrameLike[] = [candidateFrame()];
  let metrics: ProcessMetricSample[] = [];
  const killPid = vi.fn();
  const sendToRenderer = vi.fn();
  const watchdog = new DesignFrameWatchdog({
    getTargets: () => opts?.targets ?? [{ origin: ORIGIN, runId: RUN_ID }],
    getFrames: opts?.getFrames ?? (() => frames),
    getMetrics: () => metrics,
    killPid,
    sendToRenderer,
    cpuCount: CPU_COUNT,
    mainProcessPid: opts?.mainProcessPid ?? 999999,
  });
  return {
    watchdog,
    killPid,
    sendToRenderer,
    setFrames: (f) => (frames = f),
    setMetrics: (m) => (metrics = m),
  };
}

describe('DesignFrameWatchdog CPU rule', () => {
  it('does not kill on the first pegged sample (needs three consecutive)', () => {
    const h = makeHarness();
    h.setMetrics([{ pid: FRAME_PID, percentCPUUsage: HOT_CPU, workingSetSizeKB: COOL_MEM_KB }]);
    h.watchdog.poll();
    expect(h.killPid).not.toHaveBeenCalled();
  });

  it('treats a delta-based 0 first reading as not hot (priming)', () => {
    const h = makeHarness();
    // Real getAppMetrics first sample reads 0% for a just-spawned pid.
    h.setMetrics([{ pid: FRAME_PID, percentCPUUsage: 0, workingSetSizeKB: COOL_MEM_KB }]);
    h.watchdog.poll();
    h.watchdog.poll();
    expect(h.killPid).not.toHaveBeenCalled();
  });

  it('kills after 3 consecutive hot samples; a cool sample in between resets the streak', () => {
    const h = makeHarness();
    const hot = () => h.setMetrics([{ pid: FRAME_PID, percentCPUUsage: HOT_CPU, workingSetSizeKB: COOL_MEM_KB }]);
    const cool = () => h.setMetrics([{ pid: FRAME_PID, percentCPUUsage: COOL_CPU, workingSetSizeKB: COOL_MEM_KB }]);

    hot(); h.watchdog.poll(); // streak 1
    hot(); h.watchdog.poll(); // streak 2
    cool(); h.watchdog.poll(); // reset
    expect(h.killPid).not.toHaveBeenCalled();

    hot(); h.watchdog.poll(); // streak 1
    hot(); h.watchdog.poll(); // streak 2
    expect(h.killPid).not.toHaveBeenCalled();
    hot(); h.watchdog.poll(); // streak 3 -> kill
    expect(h.killPid).toHaveBeenCalledTimes(1);
    expect(h.killPid).toHaveBeenCalledWith(FRAME_PID);
  });

  it('emits a frame-terminated event with reason=cpu and the origin runId on kill', () => {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) {
      h.setMetrics([{ pid: FRAME_PID, percentCPUUsage: HOT_CPU, workingSetSizeKB: COOL_MEM_KB }]);
      h.watchdog.poll();
    }
    expect(h.sendToRenderer).toHaveBeenCalledWith({ runId: RUN_ID, kind: 'frame-terminated', reason: 'cpu' });
  });
});

describe('DesignFrameWatchdog memory rule', () => {
  it('kills after 2 consecutive over-limit working-set samples', () => {
    const h = makeHarness();
    h.setMetrics([{ pid: FRAME_PID, percentCPUUsage: 0, workingSetSizeKB: HOT_MEM_KB }]);
    h.watchdog.poll(); // mem streak 1
    expect(h.killPid).not.toHaveBeenCalled();
    h.setMetrics([{ pid: FRAME_PID, percentCPUUsage: 0, workingSetSizeKB: HOT_MEM_KB }]);
    h.watchdog.poll(); // mem streak 2 -> kill
    expect(h.killPid).toHaveBeenCalledTimes(1);
    expect(h.sendToRenderer).toHaveBeenCalledWith({ runId: RUN_ID, kind: 'frame-terminated', reason: 'memory' });
  });

  it('does not kill when a memory spike is not sustained across two samples', () => {
    const h = makeHarness();
    h.setMetrics([{ pid: FRAME_PID, percentCPUUsage: 0, workingSetSizeKB: HOT_MEM_KB }]);
    h.watchdog.poll();
    h.setMetrics([{ pid: FRAME_PID, percentCPUUsage: 0, workingSetSizeKB: COOL_MEM_KB }]);
    h.watchdog.poll();
    expect(h.killPid).not.toHaveBeenCalled();
  });
});

describe('DesignFrameWatchdog disposal guard', () => {
  it('does not crash or kill when a frame throws on property access', () => {
    const disposed: FrameLike = {
      get url(): string {
        throw new Error('Render frame was disposed');
      },
      get osProcessId(): number {
        throw new Error('Render frame was disposed');
      },
    };
    const h = makeHarness({ getFrames: () => [disposed] });
    h.setMetrics([{ pid: FRAME_PID, percentCPUUsage: HOT_CPU, workingSetSizeKB: HOT_MEM_KB }]);
    expect(() => {
      for (let i = 0; i < 5; i++) h.watchdog.poll();
    }).not.toThrow();
    expect(h.killPid).not.toHaveBeenCalled();
  });

  it('still processes a healthy candidate when another frame is disposed', () => {
    const disposed: FrameLike = {
      get url(): string {
        throw new Error('Render frame was disposed');
      },
      get osProcessId(): number {
        throw new Error('disposed');
      },
    };
    let frames: FrameLike[] = [disposed, candidateFrame()];
    const killPid = vi.fn();
    const watchdog = new DesignFrameWatchdog({
      getTargets: () => [{ origin: ORIGIN, runId: RUN_ID }],
      getFrames: () => frames,
      getMetrics: () => [{ pid: FRAME_PID, percentCPUUsage: HOT_CPU, workingSetSizeKB: COOL_MEM_KB }],
      killPid,
      sendToRenderer: vi.fn(),
      cpuCount: CPU_COUNT,
      mainProcessPid: 999999,
    });
    for (let i = 0; i < 3; i++) watchdog.poll();
    expect(killPid).toHaveBeenCalledTimes(1);
    expect(killPid).toHaveBeenCalledWith(FRAME_PID);
    frames = []; // frame gone
  });
});

describe('DesignFrameWatchdog kill guards', () => {
  it('never kills a frame whose pid is the main process pid', () => {
    const h = makeHarness({ mainProcessPid: FRAME_PID });
    for (let i = 0; i < 5; i++) {
      h.setMetrics([{ pid: FRAME_PID, percentCPUUsage: HOT_CPU, workingSetSizeKB: HOT_MEM_KB }]);
      h.watchdog.poll();
    }
    expect(h.killPid).not.toHaveBeenCalled();
  });

  it('never kills a non-prototype (host) frame even when it is pegged', () => {
    const hostFrame: FrameLike = { url: 'file:///app/index.html', osProcessId: 100 };
    const h = makeHarness({ getFrames: () => [hostFrame] });
    for (let i = 0; i < 5; i++) {
      h.setMetrics([{ pid: 100, percentCPUUsage: HOT_CPU, workingSetSizeKB: HOT_MEM_KB }]);
      h.watchdog.poll();
    }
    expect(h.killPid).not.toHaveBeenCalled();
  });

  it('does not kill when no server is registered (empty targets)', () => {
    const h = makeHarness({ targets: [] });
    for (let i = 0; i < 5; i++) {
      h.setMetrics([{ pid: FRAME_PID, percentCPUUsage: HOT_CPU, workingSetSizeKB: HOT_MEM_KB }]);
      h.watchdog.poll();
    }
    expect(h.killPid).not.toHaveBeenCalled();
  });

  it('guards against a throwing kill (pid already gone) without re-killing', () => {
    const h = makeHarness();
    h.killPid.mockImplementation(() => {
      throw new Error('ESRCH');
    });
    for (let i = 0; i < 3; i++) {
      h.setMetrics([{ pid: FRAME_PID, percentCPUUsage: HOT_CPU, workingSetSizeKB: COOL_MEM_KB }]);
      h.watchdog.poll();
    }
    expect(h.killPid).toHaveBeenCalledTimes(1);
    // The next hot pass must not re-kill: the pid's streak was dropped after the kill.
    h.setMetrics([{ pid: FRAME_PID, percentCPUUsage: HOT_CPU, workingSetSizeKB: COOL_MEM_KB }]);
    h.watchdog.poll();
    expect(h.killPid).toHaveBeenCalledTimes(1);
  });
});
