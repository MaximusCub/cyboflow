import { IpcMain } from 'electron';
import type { AppServices } from './types';
import { ModelAvailabilityService } from '../services/modelAvailabilityService';
import type { ModelAvailabilityMap } from '../../../shared/types/modelAvailability';
import type { CodexModelCatalog, ClaudeModelCatalog } from '../../../shared/types/agentModels';

type ModelCatalogResponse =
  | { success: true; data: CodexModelCatalog }
  | { success: false; error: string };

type ClaudeModelCatalogResponse =
  | { success: true; data: ClaudeModelCatalog }
  | { success: false; error: string };

/**
 * Model IPC exposes both Claude guarded-model availability and the model catalog
 * advertised by the bundled Codex runtime. Codex discovery remains main-owned so
 * renderer reloads and multiple picker mounts do not spawn redundant probes.
 *
 * Returns an empty map when the service isn't initialized (early boot / tests) —
 * every alias then reads as usable, the optimistic default.
 */
export function registerModelHandlers(ipcMain: IpcMain, services: AppServices): void {
  ipcMain.handle(
    'models:get-availability',
    (): { success: true; data: ModelAvailabilityMap } => ({
      success: true,
      data: ModelAvailabilityService.tryGetInstance()?.snapshot() ?? {},
    }),
  );
  ipcMain.handle(
    'models:get-codex-catalog',
    async (): Promise<ModelCatalogResponse> => {
      try {
        return {
          success: true,
          data: await services.codexSdkManager.getCodexModelCatalog(),
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
  // Dynamic Claude catalog — the "Other models" section below the pinned four.
  // getCatalog() never throws (a failed probe resolves to an empty list), but the
  // envelope is kept for parity with the Codex handler and belt-and-suspenders.
  ipcMain.handle(
    'models:get-claude-catalog',
    async (): Promise<ClaudeModelCatalogResponse> => {
      try {
        return {
          success: true,
          data: await services.claudeModelCatalogService.getCatalog(),
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
}
