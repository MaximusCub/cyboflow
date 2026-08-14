/**
 * ompApprovalBridge — answers every `extension_ui_request` an `omp --mode rpc-ui`
 * session raises, deterministically and without ever waiting.
 *
 * ===========================================================================
 * WHY EVERY KIND IS ANSWERED, NOT JUST THE APPROVAL PROMPT
 * ===========================================================================
 * Four of OMP's UI methods BLOCK the agent until the host replies: `select`,
 * `confirm`, `input`, and `editor` each register a pending request and await it
 * (`requestRpcDialog`, rpc-mode.ts:606-655; `requestRpcEditor`, :540-604). An
 * unanswered one never resolves, the turn never reaches `agent_end`, and
 * `runTurn` hangs until the manager's turn timeout fires — the failure mode
 * proposal §5.3 calls out (adversarial-review finding #7). So this bridge
 * answers all four, plus anything it does not recognize, and never blocks on
 * anything to do it.
 *
 * The remaining methods are fire-and-forget by construction — `notify`
 * (rpc-mode.ts:798-806), `setStatus` (:809-817), `setWidget` (:824-833),
 * `setTitle` (:847-856), `set_editor_text` (:868-876), `open_url` (:1409-1416)
 * and the outbound `cancel` dismissal (rpc-types.ts:391) all emit without
 * registering a pending request. They are logged and dropped.
 *
 * ===========================================================================
 * THE APPROVAL PROMPT
 * ===========================================================================
 * OMP's tool-approval gate raises `select(formatApprovalPrompt(...),
 * ["Approve", "Deny"])` (`extensibility/extensions/wrapper.ts:325`) and treats
 * the call as approved iff the answer is exactly `"Approve"` (:330). The prompt
 * body's first line is `Allow tool: <name>` (`tools/approval.ts:259`), which is
 * how this bridge tells that dialog apart from an extension's own `select`.
 *
 * ANSWERING "Approve" IS NOT A POLICY DECISION — it is the absence of one. The
 * gating extension runs on `tool_call`, BEFORE this prompt, and a block there
 * suppresses the prompt entirely (`wrapper.ts:201-235` precedes `:237-339`; see
 * `gate/ompGateTypes.ts` (d)). Every prompt that reaches this bridge is
 * therefore for a call cyboflow's own predicate ALREADY allowed — denying it
 * here would deadlock cyboflow's policy against OMP's redundant second gate.
 *
 * The one case where that reasoning does not hold is a session whose gate never
 * loaded, and there the answer flips to Deny plus a surfaced error. That is
 * defense in depth only: the manager verifies the gate's load sentinel before
 * the first prompt and refuses the session outright when it is missing, so this
 * branch should be unreachable in a session that got as far as running a tool.
 */
import type { Logger } from '../../../utils/logger';
import type { OmpExtensionUiRequestEvent, OmpExtensionUiResponse } from './rpc';

/** First line of OMP's tool-approval prompt body (`tools/approval.ts:259`). */
export const OMP_APPROVAL_PROMPT_PREFIX = 'Allow tool: ';

/** The two options OMP's approval gate offers (`wrapper.ts:325`). */
export const OMP_APPROVE_OPTION = 'Approve';
export const OMP_DENY_OPTION = 'Deny';

/** What the bridge did with one request — returned for tests and log lines. */
export type OmpUiRequestDisposition =
  /** Approval prompt answered `Approve`. */
  | 'approved'
  /** Approval prompt answered `Deny` (gate unverified). */
  | 'denied'
  /** A blocking dialog cancelled/declined because v1 has no question bridge. */
  | 'declined'
  /** A fire-and-forget method: logged, no response written. */
  | 'acknowledged'
  /** The response could not be written (dead transport). */
  | 'failed';

export interface OmpApprovalBridgeOptions {
  /** Writes one `extension_ui_response` frame — `OmpRpcClient.respondToExtensionUi`. */
  respond(response: OmpExtensionUiResponse): void;
  /**
   * Whether the gate extension's load sentinel was verified for this session.
   * Read per request rather than captured, so a bridge built before the
   * handshake still reflects the verified state once it lands.
   */
  isGateVerified(): boolean;
  /** Surfaces a user-visible panel error (the manager's `error` event). */
  onSurfacedError(message: string): void;
  logger?: Logger;
}

export class OmpApprovalBridge {
  constructor(private readonly options: OmpApprovalBridgeOptions) {}

  /** Answer (or acknowledge) one `extension_ui_request`. Never throws, never waits. */
  handleUiRequest(event: OmpExtensionUiRequestEvent): OmpUiRequestDisposition {
    switch (event.method) {
      case 'select':
        return this.handleSelect(event);
      case 'confirm':
        // `{confirmed:false}` is the explicit decline OMP parses at
        // rpc-mode.ts:760-775; `{cancelled:true}` would also resolve false, but
        // the explicit form records that a host decided rather than timed out.
        return this.decline(event, { type: 'extension_ui_response', id: event.id, confirmed: false });
      case 'input':
      case 'editor':
        // Both resolve to `undefined` on a cancel — `parseValueDialogResponse`
        // (rpc-mode.ts:521-531) and `requestRpcEditor`'s own resolver (:585-593).
        return this.decline(event, { type: 'extension_ui_response', id: event.id, cancelled: true });
      case 'notify':
      case 'setStatus':
      case 'setWidget':
      case 'setTitle':
      case 'set_editor_text':
      case 'open_url':
      case 'cancel':
        this.options.logger?.verbose(
          `[OmpApprovalBridge] ignored fire-and-forget ui request ${event.method}`,
        );
        return 'acknowledged';
      default:
        // An unmodeled method may or may not block. Cancelling costs nothing if
        // it does not — an id with no pending request is dropped by OMP's own
        // dispatcher (rpc-mode.ts:278-284) — and unblocks the turn if it does.
        this.options.logger?.warn(
          `[OmpApprovalBridge] cancelling unrecognized ui request method "${event.method}"`,
        );
        return this.write(
          { type: 'extension_ui_response', id: event.id, cancelled: true },
          'declined',
        );
    }
  }

  private handleSelect(event: OmpExtensionUiRequestEvent): OmpUiRequestDisposition {
    const title = event.title ?? '';
    if (!title.startsWith(OMP_APPROVAL_PROMPT_PREFIX)) {
      // An extension's own picker. v1 has no question bridge, so it is cancelled
      // (rpc-mode.ts:521-531 turns that into `undefined` for the caller).
      return this.decline(event, { type: 'extension_ui_response', id: event.id, cancelled: true });
    }

    const options = event.options ?? [];
    if (!this.options.isGateVerified()) {
      const message =
        `cyboflow denied an OMP tool approval (${firstLine(title)}): the gating extension's load ` +
        'sentinel was never verified, so cyboflow cannot vouch for this call. The session should ' +
        'have been refused at spawn — stop it and check the OMP gate configuration.';
      this.options.onSurfacedError(message);
      this.options.logger?.error(`[OmpApprovalBridge] ${message}`);
      return options.length === 0 || options.includes(OMP_DENY_OPTION)
        ? this.write({ type: 'extension_ui_response', id: event.id, value: OMP_DENY_OPTION }, 'denied')
        // No `Deny` option to pick: a cancel resolves to `undefined`, which
        // `choice === "Approve"` reads as not-approved just the same.
        : this.write({ type: 'extension_ui_response', id: event.id, cancelled: true }, 'denied');
    }

    if (options.length > 0 && !options.includes(OMP_APPROVE_OPTION)) {
      // Shaped like the approval prompt but not offering OMP's own approve
      // option — refuse rather than guess which label means yes.
      const message =
        `cyboflow could not answer an OMP approval prompt (${firstLine(title)}): it offered ` +
        `[${options.join(', ')}] rather than the expected "${OMP_APPROVE_OPTION}" option.`;
      this.options.onSurfacedError(message);
      this.options.logger?.error(`[OmpApprovalBridge] ${message}`);
      return this.write({ type: 'extension_ui_response', id: event.id, cancelled: true }, 'declined');
    }

    this.options.logger?.verbose(
      `[OmpApprovalBridge] auto-approving gate-vetted tool call (${firstLine(title)})`,
    );
    return this.write(
      { type: 'extension_ui_response', id: event.id, value: OMP_APPROVE_OPTION },
      'approved',
    );
  }

  private decline(
    event: OmpExtensionUiRequestEvent,
    response: OmpExtensionUiResponse,
  ): OmpUiRequestDisposition {
    const message =
      `cyboflow declined an OMP "${event.method}" dialog${event.title ? ` (${firstLine(event.title)})` : ''}: ` +
      'this build has no question bridge for OMP, so interactive prompts other than tool approval ' +
      'are answered as cancelled. Ask the agent to proceed without the prompt.';
    this.options.onSurfacedError(message);
    this.options.logger?.warn(`[OmpApprovalBridge] ${message}`);
    return this.write(response, 'declined');
  }

  private write(
    response: OmpExtensionUiResponse,
    disposition: OmpUiRequestDisposition,
  ): OmpUiRequestDisposition {
    try {
      this.options.respond(response);
      return disposition;
    } catch (error) {
      // A dead transport is already fatal for the turn; losing the reply here
      // must not also take down the event listener that called us.
      this.options.logger?.warn(
        `[OmpApprovalBridge] failed to answer ui request ${response.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return 'failed';
    }
  }
}

/** OMP's approval body is multi-line; only its headline is worth surfacing. */
function firstLine(value: string): string {
  const line = value.split('\n', 1)[0] ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
