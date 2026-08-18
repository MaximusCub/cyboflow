/**
 * Unit tests for OmpApprovalBridge.
 *
 * The governing property, asserted per kind: a `extension_ui_request` the bridge
 * sees is ANSWERED — synchronously, with no timer anywhere in the path. That is
 * what keeps an OMP turn from hanging on an unanswered blocking dialog (proposal
 * §5.3, adversarial-review finding #7), so `resolvesWithoutTimeout` drives each
 * blocking kind through a stub that only settles when a response arrives, and
 * awaits it under fake timers with the clock never advanced.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  OMP_APPROVAL_PROMPT_PREFIX,
  OmpApprovalBridge,
  type OmpApprovalBridgeOptions,
} from '../ompApprovalBridge';
import type { OmpExtensionUiRequestEvent, OmpExtensionUiResponse } from '../rpc';

function makeBridge(overrides: Partial<OmpApprovalBridgeOptions> = {}): {
  bridge: OmpApprovalBridge;
  responses: OmpExtensionUiResponse[];
  errors: string[];
} {
  const responses: OmpExtensionUiResponse[] = [];
  const errors: string[] = [];
  const bridge = new OmpApprovalBridge({
    respond: (response) => responses.push(response),
    isGateVerified: () => true,
    onSurfacedError: (message) => errors.push(message),
    ...overrides,
  });
  return { bridge, responses, errors };
}

function uiRequest(
  overrides: Partial<OmpExtensionUiRequestEvent> & { method: string },
): OmpExtensionUiRequestEvent {
  return { type: 'extension_ui_request', id: 'ui-1', ...overrides };
}

const APPROVAL_PROMPT = `${OMP_APPROVAL_PROMPT_PREFIX}bash\nCommand: pnpm test`;

describe('OmpApprovalBridge — the approval prompt', () => {
  it('approves a gate-vetted tool call with the exact "Approve" option label', () => {
    const { bridge, responses, errors } = makeBridge();

    const disposition = bridge.handleUiRequest(
      uiRequest({ method: 'select', title: APPROVAL_PROMPT, options: ['Approve', 'Deny'] }),
    );

    expect(disposition).toBe('approved');
    // `wrapper.ts:330` compares `choice === "Approve"` — nothing else approves.
    expect(responses).toEqual([{ type: 'extension_ui_response', id: 'ui-1', value: 'Approve' }]);
    expect(errors).toEqual([]);
  });

  it('denies and surfaces an error when the gate sentinel was never verified', () => {
    const { bridge, responses, errors } = makeBridge({ isGateVerified: () => false });

    const disposition = bridge.handleUiRequest(
      uiRequest({ method: 'select', title: APPROVAL_PROMPT, options: ['Approve', 'Deny'] }),
    );

    expect(disposition).toBe('denied');
    expect(responses).toEqual([{ type: 'extension_ui_response', id: 'ui-1', value: 'Deny' }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('sentinel');
  });

  it('cancels (still not approving) when an unverified prompt offers no Deny option', () => {
    const { bridge, responses } = makeBridge({ isGateVerified: () => false });

    expect(
      bridge.handleUiRequest(
        uiRequest({ method: 'select', title: APPROVAL_PROMPT, options: ['Yes'] }),
      ),
    ).toBe('denied');
    expect(responses).toEqual([{ type: 'extension_ui_response', id: 'ui-1', cancelled: true }]);
  });

  it('refuses to guess when an approval-shaped prompt lacks the Approve option', () => {
    const { bridge, responses, errors } = makeBridge();

    expect(
      bridge.handleUiRequest(
        uiRequest({ method: 'select', title: APPROVAL_PROMPT, options: ['Yes', 'No'] }),
      ),
    ).toBe('declined');
    expect(responses).toEqual([{ type: 'extension_ui_response', id: 'ui-1', cancelled: true }]);
    expect(errors[0]).toContain('Approve');
  });
});

describe('OmpApprovalBridge — every other kind', () => {
  it('cancels a non-approval select', () => {
    const { bridge, responses, errors } = makeBridge();

    expect(
      bridge.handleUiRequest(
        uiRequest({ method: 'select', title: 'Pick a branch', options: ['main', 'dev'] }),
      ),
    ).toBe('declined');
    expect(responses).toEqual([{ type: 'extension_ui_response', id: 'ui-1', cancelled: true }]);
    expect(errors[0]).toContain('no question bridge');
  });

  it('declines a confirm with an explicit confirmed:false', () => {
    const { bridge, responses } = makeBridge();

    expect(
      bridge.handleUiRequest(uiRequest({ method: 'confirm', title: 'Confirm', message: 'Continue?' })),
    ).toBe('declined');
    expect(responses).toEqual([{ type: 'extension_ui_response', id: 'ui-1', confirmed: false }]);
  });

  it.each(['input', 'editor'])('cancels a blocking %s dialog', (method) => {
    const { bridge, responses } = makeBridge();

    expect(bridge.handleUiRequest(uiRequest({ method, title: 'Paste a token' }))).toBe('declined');
    expect(responses).toEqual([{ type: 'extension_ui_response', id: 'ui-1', cancelled: true }]);
  });

  it.each(['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text', 'open_url', 'cancel'])(
    'acknowledges the fire-and-forget %s without writing a response',
    (method) => {
      const { bridge, responses, errors } = makeBridge();

      expect(bridge.handleUiRequest(uiRequest({ method }))).toBe('acknowledged');
      expect(responses).toEqual([]);
      expect(errors).toEqual([]);
    },
  );

  it('cancels an unrecognized method rather than risk hanging the turn', () => {
    const { bridge, responses } = makeBridge();

    expect(bridge.handleUiRequest(uiRequest({ method: 'someFutureDialog' }))).toBe('declined');
    expect(responses).toEqual([{ type: 'extension_ui_response', id: 'ui-1', cancelled: true }]);
  });

  it('reports a failed write instead of throwing into the event listener', () => {
    const { bridge } = makeBridge({
      respond: () => {
        throw new Error('stdin closed');
      },
    });

    expect(bridge.handleUiRequest(uiRequest({ method: 'confirm', title: 'x', message: 'y' }))).toBe(
      'failed',
    );
  });
});

describe('OmpApprovalBridge — the turn never waits on a dialog', () => {
  /**
   * Stands in for OMP's side of a blocking dialog: the promise settles ONLY when
   * the bridge writes a response for that id. Awaited with fake timers installed
   * and never advanced, so a bridge that relied on any timeout would hang the
   * test rather than pass it.
   */
  async function resolvesWithoutTimeout(event: OmpExtensionUiRequestEvent): Promise<unknown> {
    vi.useFakeTimers();
    try {
      let settle: (value: OmpExtensionUiResponse) => void = () => undefined;
      const answered = new Promise<OmpExtensionUiResponse>((resolve) => {
        settle = resolve;
      });
      const { bridge } = makeBridge({
        respond: (response) => {
          if (response.id === event.id) settle(response);
        },
        isGateVerified: () => true,
      });
      bridge.handleUiRequest(event);
      return await answered;
    } finally {
      vi.useRealTimers();
    }
  }

  it.each([
    ['approval select', uiRequest({ method: 'select', title: APPROVAL_PROMPT, options: ['Approve', 'Deny'] })],
    ['plain select', uiRequest({ method: 'select', title: 'Pick one', options: ['a', 'b'] })],
    ['confirm', uiRequest({ method: 'confirm', title: 'Confirm', message: 'Continue?' })],
    ['input', uiRequest({ method: 'input', title: 'Token' })],
    ['editor', uiRequest({ method: 'editor', title: 'Message' })],
    ['unknown', uiRequest({ method: 'someFutureDialog' })],
  ])('%s resolves with no clock advance', async (_label, event) => {
    await expect(resolvesWithoutTimeout(event)).resolves.toMatchObject({ id: event.id });
  });
});
