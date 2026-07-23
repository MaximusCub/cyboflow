import { useCallback } from 'react';
import { panelApi } from '../services/panelApi';
import { usePanelStore } from '../stores/panelStore';

/**
 * Minimal session shape the hook needs. Pass `null`/`undefined` to disable
 * the callback (it will warn and no-op when invoked).
 */
export interface UseAddClaudePanelSession {
  id: string;
  worktreePath?: string;
}

export interface UseAddClaudePanelOptions {
  /** Optional side-effect run after the panel is activated. Used to track navigation history. */
  onAfterActivate?: (sessionId: string, panelId: string) => void;
  /** Log tag for the no-session guard's console.warn. Defaults to 'useAddClaudePanel'. */
  logTag?: string;
}

/**
 * Returns a memoized callback that always creates a new Claude panel for the
 * given session, registers it in the panel store, activates it, and fires the
 * optional onAfterActivate side-effect.
 */
export function useAddClaudePanel(
  session: UseAddClaudePanelSession | null | undefined,
  options: UseAddClaudePanelOptions = {},
): () => Promise<void> {
  const { addPanel, setActivePanel: setActivePanelInStore } = usePanelStore();
  const { onAfterActivate, logTag = 'useAddClaudePanel' } = options;

  return useCallback(async () => {
    if (!session) {
      console.warn(`[${logTag}] Cannot add chat: missing session`);
      return;
    }

    const newPanel = await panelApi.createPanel({
      sessionId: session.id,
      type: 'claude',
      initialState: { cwd: session.worktreePath },
    });
    addPanel(newPanel);
    setActivePanelInStore(session.id, newPanel.id);
    await panelApi.setActivePanel(session.id, newPanel.id);
    if (onAfterActivate) {
      onAfterActivate(session.id, newPanel.id);
    }
  }, [session, addPanel, setActivePanelInStore, onAfterActivate, logTag]);
}
