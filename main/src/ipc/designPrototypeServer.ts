/**
 * IPC handlers for the Design Mode v1 interactive prototype server (design-mode.md
 * "Process isolation" + "Server lifecycle"). The design surface `ensure`s a
 * token-gated loopback server on entry/respawn and `stop`s it on exit; the
 * watchdog's out-of-band frame terminations + server stops stream back over
 * DESIGN_PROTO_SERVER_EVENT_CHANNEL (pushed by the manager/watchdog, not here).
 *
 *   design:proto-server:ensure        { runId } -> IPCResponse<{ baseUrl }>
 *   design:proto-server:stop          { runId } -> IPCResponse<{ stopped }>
 *   design:proto-server:host-comment  { runId, sanitizedHtml } -> IPCResponse<{ url }>
 *
 * The `{ success, data?, error? }` envelope mirrors registerArtifactHtmlHandlers
 * (the preload bridge unwraps `data`). Channel constants + request/result shapes
 * come from the shared contract so main and preload cannot drift.
 */
import type { IpcMain } from 'electron';
import {
  DESIGN_PROTO_SERVER_ENSURE_CHANNEL,
  DESIGN_PROTO_SERVER_STOP_CHANNEL,
  DESIGN_PROTO_SERVER_HOST_COMMENT_CHANNEL,
  MAX_COMMENT_DOCUMENT_BYTES,
  type EnsurePrototypeServerRequest,
  type EnsurePrototypeServerResult,
  type StopPrototypeServerRequest,
  type StopPrototypeServerResult,
  type HostCommentDocumentRequest,
  type HostCommentDocumentResult,
} from '../../../shared/types/designPrototypeServer';
import type { DesignPrototypeServerManager } from '../services/designPrototypeServer';

/** IPCResponse-compatible envelope (mirrors frontend/src/utils/api.ts). */
interface IpcResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export function registerDesignPrototypeServerHandlers(
  ipcMain: IpcMain,
  manager: DesignPrototypeServerManager,
): void {
  ipcMain.handle(
    DESIGN_PROTO_SERVER_ENSURE_CHANNEL,
    async (_event, req: EnsurePrototypeServerRequest): Promise<IpcResult<EnsurePrototypeServerResult>> => {
      try {
        const runId = typeof req?.runId === 'string' ? req.runId : '';
        if (runId.length === 0) {
          return { success: false, error: 'A runId is required.' };
        }
        const baseUrl = await manager.ensure(runId);
        return { success: true, data: { baseUrl } };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to start the prototype server.',
        };
      }
    },
  );

  ipcMain.handle(
    DESIGN_PROTO_SERVER_STOP_CHANNEL,
    async (_event, req: StopPrototypeServerRequest): Promise<IpcResult<StopPrototypeServerResult>> => {
      try {
        const runId = typeof req?.runId === 'string' ? req.runId : '';
        if (runId.length === 0) {
          return { success: false, error: 'A runId is required.' };
        }
        const stopped = await manager.stop(runId);
        return { success: true, data: { stopped } };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to stop the prototype server.',
        };
      }
    },
  );

  // Comment mode (design-mode.md "Comment mode — live-DOM freeze + sanitizer +
  // nonce-CSP"): host the renderer's sanitized freeze as the run's CURRENT
  // comment document and hand back its tokenized URL. The bytes are untrusted
  // content — the nonce CSP the manager attaches is the enforcement — so the
  // only thing validated here is the SHAPE and the size cap (design-mode.md:
  // "the parent additionally validates message schema, caps payload size").
  ipcMain.handle(
    DESIGN_PROTO_SERVER_HOST_COMMENT_CHANNEL,
    async (_event, req: HostCommentDocumentRequest): Promise<IpcResult<HostCommentDocumentResult>> => {
      try {
        const runId = typeof req?.runId === 'string' ? req.runId : '';
        if (runId.length === 0) {
          return { success: false, error: 'A runId is required.' };
        }
        const sanitizedHtml = typeof req?.sanitizedHtml === 'string' ? req.sanitizedHtml : '';
        if (sanitizedHtml.length === 0) {
          return { success: false, error: 'A sanitized comment document is required.' };
        }
        // Bytes, not code units — a capture full of multi-byte text would slip a
        // `.length` cap.
        if (Buffer.byteLength(sanitizedHtml, 'utf-8') > MAX_COMMENT_DOCUMENT_BYTES) {
          return { success: false, error: 'The captured document is too large to host.' };
        }
        const { url } = await manager.hostCommentDocument(runId, sanitizedHtml);
        return { success: true, data: { url } };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to host the comment document.',
        };
      }
    },
  );
}
