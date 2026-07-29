/**
 * OrchestratorHealth — exposes the MCP server's runtime status for the
 * health-check IPC channel and the tRPC cyboflow.health.mcpServer procedure.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 *
 * See also: main/src/orchestrator/trpc/routers/health.ts (tRPC procedure).
 */
import type { McpServerHealth } from '../../../shared/types/mcpHealth';
import type { McpServerStatus } from './mcpServer/mcpServerLifecycle';

// Re-export so consumers that imported McpServerHealth from this module
// continue to compile without update.
export type { McpServerHealth } from '../../../shared/types/mcpHealth';

/**
 * Narrow observable interface required by OrchestratorHealth.
 *
 * Accepts the concrete McpServerLifecycle (structural match) as well as any
 * stub or sentinel that satisfies these two methods — useful at boot when the
 * real lifecycle is not yet wired (e.g. epic 7 permissionIpcServer pending).
 */
export interface McpLifecycleReadable {
  getStatus(): McpServerStatus;
  getRestartAttempts(): number;
}

/** Optional collaborators. Omitted ⇒ behaviour is byte-identical to before. */
export interface OrchestratorHealthDeps {
  /**
   * Sync probe: does the orch socket path still resolve to the inode the
   * OrchSocketServer bound? Wire to `orchSocketServer.isSocketPathIntact`.
   *
   * The lifecycle state machine only knows whether the long-lived MCP
   * SUBPROCESS is up. It cannot see that the socket path those subprocesses
   * dial has been unlinked — so on 2026-07-28 it reported 'running' for two
   * days while every newly spawned subprocess died on ENOENT.
   */
  isSocketPathIntact?: () => boolean;
}

/** lastError text when the socket path is gone but the lifecycle says running. */
export const SOCKET_PATH_LOST_ERROR =
  'Orchestrator socket file is missing or was replaced by another instance — ' +
  'existing connections still work, but no new MCP subprocess can connect. Restart Cyboflow.';

/**
 * Aggregates runtime health data for the cyboflow orchestrator subsystem.
 *
 * Usage (in main/src/index.ts):
 * ```ts
 * const health = new OrchestratorHealth(mcpLifecycle);
 * setHealthProvider(health); // wires the tRPC cyboflow.health.mcpServer procedure
 * ```
 *
 * The constructor accepts any McpLifecycleReadable, so a sentinel can be
 * passed at boot before the real McpServerLifecycle is available (epic 7).
 */
export class OrchestratorHealth {
  private lastMcpError: string | undefined;

  /**
   * @param mcpLifecycle  Any object satisfying McpLifecycleReadable.
   *                      Typically the real McpServerLifecycle singleton;
   *                      a sentinel stub is acceptable at boot.
   */
  constructor(
    private readonly mcpLifecycle: McpLifecycleReadable,
    private readonly deps: OrchestratorHealthDeps = {},
  ) {}

  /**
   * Record an MCP-server-level error string.
   *
   * Call this from orchestrator catch blocks that handle lifecycle errors
   * (e.g. after mcpLifecycle.start() throws or status moves to 'failed').
   * The error string surfaces in the Sidebar tooltip so the user can read it
   * without opening DevTools.
   */
  setMcpError(err: string): void {
    this.lastMcpError = err;
  }

  /**
   * Returns a point-in-time snapshot of the MCP server's health.
   *
   * The status field is read directly from the lifecycle's state machine;
   * the lastError is the most recent error string captured via setMcpError().
   * restartAttempts reflects how many automatic restarts have been attempted
   * since the last manual start() call.
   */
  getMcpServerStatus(): McpServerHealth {
    const status = this.mcpLifecycle.getStatus();
    const restartAttempts = this.mcpLifecycle.getRestartAttempts();

    // A live subprocess is necessary but NOT sufficient: if the socket path it
    // dials is gone, the subsystem is unreachable to everything spawned from
    // here on. Report that as 'failed' (→ 'error' in the UI) rather than
    // inheriting the lifecycle's green, so the sidebar stops claiming health the
    // subsystem does not have. Only downgrade a 'running' claim — 'starting',
    // 'failed' and 'stopped' already describe themselves accurately, and during
    // 'starting' the socket legitimately does not exist yet.
    if (status === 'running' && this.deps.isSocketPathIntact?.() === false) {
      return {
        status: 'failed',
        lastError: this.lastMcpError ?? SOCKET_PATH_LOST_ERROR,
        restartAttempts,
      };
    }

    return { status, lastError: this.lastMcpError, restartAttempts };
  }
}
