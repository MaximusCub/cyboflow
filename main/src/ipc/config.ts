import { IpcMain } from 'electron';
import type { AppServices } from './types';
import {
  isAgentProviderAccess,
  resolveAgentProviderAccess,
} from '../../../shared/types/agentRuntime';

export function registerConfigHandlers(ipcMain: IpcMain, { configManager, claudeCodeManager }: AppServices): void {
  ipcMain.handle('config:get', async () => {
    try {
      const config = configManager.getConfig();
      return { success: true, data: config };
    } catch (error) {
      console.error('Failed to get config:', error);
      return { success: false, error: 'Failed to get config' };
    }
  });

  ipcMain.handle('config:update', async (_event, updates: import('../types/config').UpdateConfigRequest) => {
    try {
      // Check if Claude path is being updated
      const oldConfig = configManager.getConfig();
      const claudePathChanged = updates.claudeExecutablePath !== undefined &&
                               updates.claudeExecutablePath !== oldConfig.claudeExecutablePath;

      // Validate the untyped provider-access patch at the IPC boundary: a
      // malformed shape is rejected outright, and a well-formed one is stored
      // normalized (both members explicit, never all-off) so every downstream
      // read — including a config.json edited by hand — sees the floors already
      // applied. See shared/types/agentRuntime.ts.
      if (updates.agentProviderAccess !== undefined && !isAgentProviderAccess(updates.agentProviderAccess)) {
        return { success: false, error: 'Invalid agentProviderAccess payload' };
      }
      const normalized = updates.agentProviderAccess === undefined
        ? updates
        : { ...updates, agentProviderAccess: resolveAgentProviderAccess(updates.agentProviderAccess) };

      await configManager.updateConfig(normalized);
      
      // Clear Claude availability cache if the path changed
      if (claudePathChanged) {
        claudeCodeManager.clearAvailabilityCache();
        console.log('[Config] Claude executable path changed, cleared availability cache');
      }
      
      return { success: true };
    } catch (error) {
      console.error('Failed to update config:', error);
      return { success: false, error: 'Failed to update config' };
    }
  });

  ipcMain.handle('config:get-session-preferences', async () => {
    try {
      const preferences = configManager.getSessionCreationPreferences();
      return { success: true, data: preferences };
    } catch (error) {
      console.error('Failed to get session creation preferences:', error);
      return { success: false, error: 'Failed to get session creation preferences' };
    }
  });

  ipcMain.handle('config:update-session-preferences', async (_event, preferences: NonNullable<import('../types/config').AppConfig['sessionCreationPreferences']>) => {
    try {
      await configManager.updateConfig({ sessionCreationPreferences: preferences });
      return { success: true };
    } catch (error) {
      console.error('Failed to update session creation preferences:', error);
      return { success: false, error: 'Failed to update session creation preferences' };
    }
  });
} 