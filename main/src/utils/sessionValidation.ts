import { databaseService } from '../services/database';
import { panelManager } from '../services/panelManager';

export interface ValidationResult {
  valid: boolean;
  error?: string;
  sessionId?: string;
  panelId?: string;
  /**
   * Set when the rejection is an EXPECTED lifecycle race rather than a defect,
   * so {@link logValidationFailure} can drop the log level. Archiving a session
   * flips `archived` while its manager still has output events in flight; those
   * trailing events are correctly dropped here, but logging each one at ERROR
   * reported a bug that isn't one (4× per archive in the 2026-08-03 smoke run,
   * found independently by both arms). The rejection itself is unchanged — only
   * how loudly it is reported.
   */
  expected?: boolean;
}

/**
 * Validates that a session exists and is not archived
 */
export function validateSessionExists(sessionId: string): ValidationResult {
  if (!sessionId) {
    return { valid: false, error: 'Session ID is required', sessionId };
  }

  const session = databaseService.getSession(sessionId);
  if (!session) {
    return { valid: false, error: `Session ${sessionId} not found`, sessionId };
  }

  if (session.archived) {
    return { valid: false, error: `Session ${sessionId} is archived`, sessionId, expected: true };
  }

  return { valid: true, sessionId };
}

/**
 * Validates that a panel exists and belongs to the specified session
 */
export function validatePanelSessionOwnership(panelId: string, expectedSessionId: string): ValidationResult {
  if (!panelId) {
    return { valid: false, error: 'Panel ID is required', panelId, sessionId: expectedSessionId };
  }

  if (!expectedSessionId) {
    return { valid: false, error: 'Session ID is required', panelId, sessionId: expectedSessionId };
  }

  // First validate the session exists
  const sessionValidation = validateSessionExists(expectedSessionId);
  if (!sessionValidation.valid) {
    return { ...sessionValidation, panelId };
  }

  // Get the panel and check ownership
  const panel = panelManager.getPanel(panelId);
  if (!panel) {
    return { valid: false, error: `Panel ${panelId} not found`, panelId, sessionId: expectedSessionId };
  }

  if (panel.sessionId !== expectedSessionId) {
    return { 
      valid: false, 
      error: `Panel ${panelId} belongs to session ${panel.sessionId}, not ${expectedSessionId}`,
      panelId,
      sessionId: expectedSessionId
    };
  }

  return { valid: true, panelId, sessionId: expectedSessionId };
}

/**
 * Validates that a panel exists (without checking session ownership)
 */
export function validatePanelExists(panelId: string): ValidationResult {
  if (!panelId) {
    return { valid: false, error: 'Panel ID is required', panelId };
  }

  const panel = panelManager.getPanel(panelId);
  if (!panel) {
    return { valid: false, error: `Panel ${panelId} not found`, panelId };
  }

  return { valid: true, panelId, sessionId: panel.sessionId };
}

/**
 * Validates that a session is active (not archived and status allows operations)
 */
export function validateSessionIsActive(sessionId: string): ValidationResult {
  const sessionValidation = validateSessionExists(sessionId);
  if (!sessionValidation.valid) {
    return sessionValidation;
  }

  const session = databaseService.getSession(sessionId);
  if (!session) {
    return { valid: false, error: `Session ${sessionId} not found`, sessionId };
  }

  // Check if session is in a state that allows operations
  const inactiveStatuses = ['archived'];
  if (inactiveStatuses.includes(session.status)) {
    return { 
      valid: false, 
      error: `Session ${sessionId} is in ${session.status} state and cannot receive operations`, 
      sessionId 
    };
  }

  return { valid: true, sessionId };
}

/**
 * Validates that an event matches the expected session context
 */
export function validateEventContext(eventData: Record<string, unknown>, expectedSessionId?: string): ValidationResult {
  if (!eventData) {
    return { valid: false, error: 'Event data is required' };
  }

  // If no expected session, just validate the event has required fields
  if (!expectedSessionId) {
    if (!eventData.sessionId) {
      return { valid: false, error: 'Event must contain sessionId' };
    }
    return validateSessionExists(String(eventData.sessionId));
  }

  // Validate event session matches expected session
  if (!eventData.sessionId) {
    return { 
      valid: false, 
      error: 'Event must contain sessionId', 
      sessionId: expectedSessionId 
    };
  }

  if (eventData.sessionId !== expectedSessionId) {
    return { 
      valid: false, 
      error: `Event sessionId ${eventData.sessionId} does not match expected ${expectedSessionId}`,
      sessionId: expectedSessionId 
    };
  }

  // Validate the session exists
  return validateSessionExists(expectedSessionId);
}

/**
 * Validates that a panel event matches the expected context
 */
export function validatePanelEventContext(
  eventData: Record<string, unknown>, 
  expectedPanelId?: string, 
  expectedSessionId?: string
): ValidationResult {
  if (!eventData) {
    return { valid: false, error: 'Event data is required' };
  }

  // If panel ID is provided, validate it
  if (expectedPanelId) {
    if (!eventData.panelId) {
      return { 
        valid: false, 
        error: 'Event must contain panelId when panel context is expected',
        panelId: expectedPanelId,
        sessionId: expectedSessionId
      };
    }

    if (eventData.panelId !== expectedPanelId) {
      return { 
        valid: false, 
        error: `Event panelId ${eventData.panelId} does not match expected ${expectedPanelId}`,
        panelId: expectedPanelId,
        sessionId: expectedSessionId
      };
    }

    // If we have expected session, validate panel ownership
    if (expectedSessionId) {
      return validatePanelSessionOwnership(expectedPanelId, expectedSessionId);
    } else {
      // Just validate panel exists
      return validatePanelExists(expectedPanelId);
    }
  }

  // Fall back to session validation if only session is provided
  if (expectedSessionId) {
    return validateEventContext(eventData, expectedSessionId);
  }

  // No specific expectations, just validate event has required data
  if (eventData.panelId) {
    return validatePanelExists(String(eventData.panelId));
  } else if (eventData.sessionId) {
    return validateSessionExists(String(eventData.sessionId));
  }

  return { valid: false, error: 'Event must contain either panelId or sessionId' };
}

/**
 * Helper to log validation failures.
 *
 * An `expected` rejection (a lifecycle race — see {@link ValidationResult}) is
 * still a rejection and still drops the event, but it is logged at INFO: only
 * unexpected rejections indicate something worth investigating.
 */
export function logValidationFailure(context: string, validation: ValidationResult): void {
  if (!validation.valid) {
    const detail = {
      error: validation.error,
      sessionId: validation.sessionId,
      panelId: validation.panelId
    };
    if (validation.expected) {
      console.log(`[Validation] ${context} skipped:`, detail);
      return;
    }
    console.error(`[Validation] ${context} failed:`, detail);
  }
}

/**
 * Helper to create a standardized validation error response
 */
export function createValidationError(validation: ValidationResult): { success: false; error: string } {
  return {
    success: false,
    error: validation.error || 'Validation failed'
  };
}