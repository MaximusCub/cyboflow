/**
 * TrackerWizardModal — the seven-step connect wizard for a Linear/Plane tracker
 * connection (Connect · Project · Source · Tasks · States · Reconcile · Review).
 *
 * Rendered as a `size="full"` Modal nested inside the Settings modal (the
 * WorkflowEditorModal pattern); Modal's cross-portal guards make the nesting
 * safe. State is flat local `useState` — this is a self-contained flow whose
 * values are handed to `cyboflow.tracker.connect` once and then forgotten, so a
 * store would only add ceremony.
 *
 * Data flow, one probe per forward step (each is a MUTATION: every call carries
 * the API key and hits the provider live, so nothing here may be cached —
 * except Step 1, which is a local project-list read, not a provider call):
 *
 *   Step 0  wizardValidate   -> the "Authorized as …" identity card
 *   Step 1  (local)          -> pick the target cyboflow project
 *   Step 2  wizardContainers + wizardNarrows -> team/project + its narrows
 *   Step 3  wizardIssues     -> the issue set the three modes filter
 *   Step 4  wizardStates     -> the mapping table, seeded from canonical groups
 *   Step 5  reconcilePreview -> pre-existing backlog rows + suggested matches
 *   Step 6  connect          -> persists the connection, then the parent refreshes
 *
 * Moving BACK never re-fetches; changing the source (or the Step-3 selection,
 * or the target project) invalidates exactly the downstream steps that depend
 * on it.
 *
 * The API key lives in this component's state and leaves only inside the
 * `credentials` field of the calls above — nothing ever reads it back.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { trpc } from '../../../trpc/client';
import { Modal } from '../../ui/Modal';
import { Button } from '../../ui/Button';
import { cn } from '../../../utils/cn';
import { API } from '../../../utils/api';
import type { Project } from '../../../types/project';
import type {
  TrackerConflictMode,
  TrackerCredentialsInput,
  TrackerDirectionMode,
  TrackerIssue,
  TrackerProvider,
  TrackerReconcileDecision,
  TrackerReconcileItem,
  TrackerSelectionJson,
  TrackerSelectionMode,
  TrackerSourceNarrow,
  TrackerSourceSelection,
  TrackerSourceTree,
  TrackerState,
  TrackerStateMapping,
  TrackerUserRef,
  TrackerWorkspaceIdentity,
} from '../../../../../shared/types/trackerSync';
import { Eyebrow, PillToggle, ProviderTile, Segmented } from './trackerShared';
import {
  MAPPING_TARGETS,
  providerMeta,
  seedStateMapping,
  trackerInputClass,
  trackerSelectClass,
} from './trackerVocabulary';

// ---------------------------------------------------------------------------
// Step vocabulary
// ---------------------------------------------------------------------------

const STEP_LABELS = ['Connect', 'Project', 'Source', 'Tasks', 'States', 'Reconcile', 'Review'] as const;
const STEP_EYEBROWS = [
  'Step 01 · Authorize',
  'Step 02 · Project',
  'Step 03 · Source',
  'Step 04 · Selection',
  'Step 05 · Mapping',
  'Step 06 · Reconcile',
  'Step 07 · Confirm',
] as const;
const LAST_STEP = STEP_LABELS.length - 1;

type ReconcileAction = TrackerReconcileDecision['action'];

const MODE_OPTIONS: readonly { value: TrackerSelectionMode; label: string }[] = [
  { value: 'all', label: 'All tasks' },
  { value: 'assignee', label: 'By assignee' },
  { value: 'manual', label: 'Manual' },
];

const DIRECTION_OPTIONS: readonly { value: TrackerDirectionMode; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'manual', label: 'Manual' },
];

function directionLabel(mode: TrackerDirectionMode): string {
  return mode === 'auto' ? 'Auto' : 'Manual';
}

const RECONCILE_OPTIONS: readonly { value: ReconcileAction; label: string; selectedClass: string }[] = [
  { value: 'keep', label: 'Keep', selectedClass: 'bg-status-success text-text-on-status-success' },
  { value: 'link', label: 'Link', selectedClass: 'bg-interactive text-text-on-interactive' },
  { value: 'discard', label: 'Discard', selectedClass: 'bg-surface-tertiary text-text-secondary' },
];

const CONFLICT_OPTIONS: readonly { value: TrackerConflictMode; label: string }[] = [
  { value: 'auto', label: 'Auto-resolve' },
  { value: 'manual', label: 'Manual review' },
];

/** Card chrome shared by every panel in the body — square corners, hairline border. */
const CARD = 'rounded-none border border-border-primary bg-surface-primary';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface TrackerWizardModalProps {
  isOpen: boolean;
  provider: TrackerProvider;
  projectId: number;
  onClose: () => void;
  /** Fired after `connect` resolves so the catalog can re-read its rows. */
  onConnected: () => void;
}

export function TrackerWizardModal({
  isOpen,
  provider,
  projectId,
  onClose,
  onConnected,
}: TrackerWizardModalProps): React.JSX.Element {
  const meta = providerMeta(provider);

  // ── Navigation ────────────────────────────────────────────────────────────
  const [step, setStep] = useState(0);
  /** Furthest step reached — the rail only navigates to steps already unlocked. */
  const [maxStep, setMaxStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [stepError, setStepError] = useState<string | null>(null);

  // ── Step 0 · credentials + identity ───────────────────────────────────────
  const [apiKey, setApiKey] = useState('');
  const [workspaceSlug, setWorkspaceSlug] = useState('');
  const [baseUrl, setBaseUrl] = useState(meta.defaultBaseUrl ?? '');
  const [validating, setValidating] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<TrackerWorkspaceIdentity | null>(null);

  // ── Step 1 · target project ───────────────────────────────────────────────
  const [projects, setProjects] = useState<Project[]>([]);
  const [targetProjectId, setTargetProjectId] = useState(projectId);

  // ── Step 2 · source ───────────────────────────────────────────────────────
  const [sourceTree, setSourceTree] = useState<TrackerSourceTree | null>(null);
  const [containerId, setContainerId] = useState<string | null>(null);
  const [narrows, setNarrows] = useState<TrackerSourceNarrow[]>([]);
  const [narrowId, setNarrowId] = useState<string | null>(null);

  // ── Step 3 · selection ────────────────────────────────────────────────────
  const [issues, setIssues] = useState<TrackerIssue[]>([]);
  const [issuesLoaded, setIssuesLoaded] = useState(false);
  const [mode, setMode] = useState<TrackerSelectionMode>('all');
  const [assignees, setAssignees] = useState<Record<string, boolean>>({});
  const [manual, setManual] = useState<Record<string, boolean>>({});

  // ── Step 4 · mapping + direction ──────────────────────────────────────────
  const [states, setStates] = useState<TrackerState[]>([]);
  const [statesLoaded, setStatesLoaded] = useState(false);
  const [mapping, setMapping] = useState<TrackerStateMapping>({});
  const [statusSyncMode, setStatusSyncMode] = useState<TrackerDirectionMode>('auto');
  const [pullMode, setPullMode] = useState<TrackerDirectionMode>('auto');
  const [pushMode, setPushMode] = useState<TrackerDirectionMode>('auto');
  const [mirrorSubissues, setMirrorSubissues] = useState(true);
  const [conflictMode, setConflictMode] = useState<TrackerConflictMode>('auto');

  // ── Step 5 · reconcile ────────────────────────────────────────────────────
  const [reconcileItems, setReconcileItems] = useState<TrackerReconcileItem[]>([]);
  const [reconcileLoaded, setReconcileLoaded] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, ReconcileAction>>({});
  const [linkTargets, setLinkTargets] = useState<Record<string, string>>({});
  /**
   * Monotonic version for the reconcile probe. Bumped whenever an in-flight
   * request is superseded (a new ensureReconcile call, or any invalidation
   * below that drops `reconcileLoaded`) so a response that arrives after its
   * request was superseded is discarded instead of installed for the wrong
   * project/source/selection.
   */
  const reconcileRequestIdRef = useRef(0);

  // ── Step 6 · submit ───────────────────────────────────────────────────────
  const [submitting, setSubmitting] = useState(false);

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  const credentials = useMemo<TrackerCredentialsInput>(() => {
    const trimmedBase = baseUrl.trim();
    // Plane workspace slugs are lowercase URL slugs; users naturally type the
    // display name ("BahiaVentures"), and the API 404s on a case mismatch.
    const trimmedSlug = workspaceSlug.trim().toLowerCase();
    return {
      provider,
      apiKey: apiKey.trim(),
      ...(meta.defaultBaseUrl !== null && trimmedBase.length > 0 ? { baseUrl: trimmedBase } : {}),
      ...(meta.needsWorkspaceSlug && trimmedSlug.length > 0 ? { workspaceSlug: trimmedSlug } : {}),
    };
  }, [provider, apiKey, baseUrl, workspaceSlug, meta.defaultBaseUrl, meta.needsWorkspaceSlug]);

  const targetProject = useMemo(
    () => projects.find((p) => p.id === targetProjectId) ?? null,
    [projects, targetProjectId],
  );
  const targetProjectName = targetProject?.name ?? `Project ${targetProjectId}`;

  const container = useMemo(
    () => sourceTree?.containers.find((c) => c.id === containerId) ?? null,
    [sourceTree, containerId],
  );
  const narrow = useMemo(
    () => narrows.find((n) => n.id === narrowId) ?? null,
    [narrows, narrowId],
  );

  const selection = useMemo<TrackerSourceSelection | null>(() => {
    if (containerId === null || narrow === null) return null;
    return { containerId, narrowId: narrow.id, narrowKind: narrow.kind };
  }, [containerId, narrow]);

  const sourceLabel = container !== null && narrow !== null ? `${container.name} · ${narrow.name}` : '';

  /** Distinct assignees across the fetched issues, with their issue counts. */
  const assigneeOptions = useMemo(() => {
    const byId = new Map<string, { user: TrackerUserRef; count: number }>();
    for (const issue of issues) {
      if (issue.assignee === null) continue;
      const entry = byId.get(issue.assignee.id);
      if (entry) entry.count += 1;
      else byId.set(issue.assignee.id, { user: issue.assignee, count: 1 });
    }
    return [...byId.values()];
  }, [issues]);

  const includedIssues = useMemo(() => {
    if (mode === 'assignee') {
      return issues.filter((i) => i.assignee !== null && assignees[i.assignee.id] === true);
    }
    if (mode === 'manual') return issues.filter((i) => manual[i.externalId] === true);
    return issues;
  }, [issues, mode, assignees, manual]);

  const selectedAssigneeIds = useMemo(
    () => Object.keys(assignees).filter((id) => assignees[id]),
    [assignees],
  );

  /** Membership set for the Step-2 list, so the row render stays linear. */
  const includedIds = useMemo(
    () => new Set(includedIssues.map((i) => i.externalId)),
    [includedIssues],
  );

  const stateCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const issue of issues) counts[issue.stateId] = (counts[issue.stateId] ?? 0) + 1;
    return counts;
  }, [issues]);

  const reconcileDecisions = useMemo<TrackerReconcileDecision[]>(
    () =>
      reconcileItems.map((item) => {
        const action = decisions[item.entityId] ?? 'keep';
        const target = linkTargets[item.entityId];
        if (action !== 'link' || target === undefined) {
          return { entityType: item.entityType, entityId: item.entityId, action };
        }
        // Carry the ref chip along with the id — the service persists these on
        // the link row and nothing back-fills them after connect.
        const issue = issues.find((i) => i.externalId === target);
        return {
          entityType: item.entityType,
          entityId: item.entityId,
          action,
          linkExternalId: target,
          linkIdentifier: issue?.identifier,
          linkUrl: issue?.url,
        };
      }),
    [reconcileItems, decisions, linkTargets, issues],
  );

  const tally = useMemo(() => {
    let keep = 0;
    let link = 0;
    let discard = 0;
    for (const d of reconcileDecisions) {
      if (d.action === 'keep') keep += 1;
      else if (d.action === 'link') link += 1;
      else discard += 1;
    }
    return { keep, link, discard };
  }, [reconcileDecisions]);

  const skippedStates = useMemo(
    () => states.filter((s) => mapping[s.id] === 'dont'),
    [states, mapping],
  );

  /**
   * Footer guards. Step 2 cannot advance without a resolved source (there is
   * nothing to probe), and Step 3's two selection modes cannot advance while
   * they resolve to an empty set.
   */
  const nextBlocked =
    (step === 2 && selection === null) ||
    (step === 3 && mode === 'assignee' && selectedAssigneeIds.length === 0) ||
    (step === 3 && mode === 'manual' && includedIssues.length === 0);

  // -------------------------------------------------------------------------
  // Invalidation — a changed upstream answer drops exactly what depended on it
  // -------------------------------------------------------------------------

  // Editing a credential retires the validated identity: the wizard past Step 0
  // is only meaningful for the key that was actually probed.
  useEffect(() => {
    setIdentity(null);
    setAuthError(null);
    setMaxStep(0);
  }, [apiKey, baseUrl, workspaceSlug]);

  // The Step-1 project list is a local read, loaded once per open. A failed
  // load leaves the list empty and the wizard on the seeded active project.
  useEffect(() => {
    if (!isOpen) return;
    void API.projects
      .getAll()
      .then((res) => {
        if (res.success && Array.isArray(res.data)) setProjects(res.data);
      })
      .catch(() => setProjects([]));
  }, [isOpen]);

  // Reconcile previews the CHOSEN project's backlog, so a retarget drops it —
  // and supersedes any reconcile request already in flight for the old target,
  // so its late response cannot install itself under the new one.
  useEffect(() => {
    reconcileRequestIdRef.current += 1;
    setReconcileLoaded(false);
    setMaxStep((m) => Math.min(m, 4));
  }, [targetProjectId]);

  // A different source means different issues, states and reconcile matches.
  useEffect(() => {
    reconcileRequestIdRef.current += 1;
    setIssues([]);
    setIssuesLoaded(false);
    setAssignees({});
    setManual({});
    setStates([]);
    setStatesLoaded(false);
    setMapping({});
    setReconcileItems([]);
    setReconcileLoaded(false);
    setDecisions({});
    setLinkTargets({});
    setMaxStep((m) => Math.min(m, 2));
  }, [containerId, narrowId]);

  // The reconcile suggestions are computed against the INCLUDED issue set, so a
  // changed Step-3 answer invalidates Step 5 (but nothing else).
  useEffect(() => {
    reconcileRequestIdRef.current += 1;
    setReconcileLoaded(false);
    setMaxStep((m) => Math.min(m, 4));
  }, [mode, assignees, manual]);

  // -------------------------------------------------------------------------
  // Probes
  // -------------------------------------------------------------------------

  const loadNarrows = async (nextContainerId: string): Promise<void> => {
    const rows = await trpc.cyboflow.tracker.wizardNarrows.mutate({
      credentials,
      containerId: nextContainerId,
    });
    setNarrows(rows);
    setNarrowId(rows.find((r) => r.kind === 'all')?.id ?? rows[0]?.id ?? null);
  };

  const ensureContainers = async (): Promise<void> => {
    if (sourceTree !== null) return;
    const tree = await trpc.cyboflow.tracker.wizardContainers.mutate({ credentials });
    setSourceTree(tree);
    const first = tree.containers[0];
    if (first) {
      setContainerId(first.id);
      await loadNarrows(first.id);
    }
  };

  const ensureIssues = async (activeSelection: TrackerSourceSelection): Promise<void> => {
    if (issuesLoaded) return;
    const rows = await trpc.cyboflow.tracker.wizardIssues.mutate({
      credentials,
      selection: activeSelection,
    });
    setIssues(rows);
    setIssuesLoaded(true);
  };

  const ensureStates = async (activeSelection: TrackerSourceSelection): Promise<void> => {
    if (statesLoaded) return;
    const rows = await trpc.cyboflow.tracker.wizardStates.mutate({
      credentials,
      selection: activeSelection,
    });
    setStates(rows);
    setMapping((prev) => seedStateMapping(rows, prev));
    setStatesLoaded(true);
  };

  const ensureReconcile = async (): Promise<void> => {
    if (reconcileLoaded) return;
    // Claim this request's version before the await so a later call (a fresh
    // ensureReconcile, or an invalidation effect below) can supersede it.
    const requestId = (reconcileRequestIdRef.current += 1);
    const rows = await trpc.cyboflow.tracker.reconcilePreview.mutate({
      projectId: targetProjectId,
      issues: includedIssues,
    });
    // The target project, source, or selection changed while this request was
    // in flight — its response no longer describes current state, so drop it.
    // Whatever superseded us already reset `reconcileLoaded`, and the next
    // visit to this step will re-fetch for the current state.
    if (reconcileRequestIdRef.current !== requestId) return;
    setReconcileItems(rows);
    // A row with a suggested match defaults to Link (pre-filled with that
    // suggestion); everything else defaults to Keep.
    const nextDecisions: Record<string, ReconcileAction> = {};
    const nextTargets: Record<string, string> = {};
    for (const row of rows) {
      if (row.suggestedExternalId !== null) {
        nextDecisions[row.entityId] = 'link';
        nextTargets[row.entityId] = row.suggestedExternalId;
      } else {
        nextDecisions[row.entityId] = 'keep';
      }
    }
    setDecisions(nextDecisions);
    setLinkTargets(nextTargets);
    setReconcileLoaded(true);
  };

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const handleAuthorize = async (): Promise<void> => {
    setValidating(true);
    setAuthError(null);
    try {
      const result = await trpc.cyboflow.tracker.wizardValidate.mutate({ credentials });
      setIdentity(result);
    } catch (err) {
      setIdentity(null);
      setAuthError(errorMessage(err));
    } finally {
      setValidating(false);
    }
  };

  const goToStep = async (target: number): Promise<void> => {
    if (target < 0 || target > LAST_STEP) return;
    // Step 0 is the gate: nothing downstream exists without a validated key.
    if (target > 0 && identity === null) return;
    setStepError(null);

    // Backwards navigation is pure — it never re-probes the provider.
    if (target <= step) {
      setStep(target);
      return;
    }

    setLoading(true);
    try {
      if (target >= 2) await ensureContainers();
      if (target >= 3) {
        if (selection === null) throw new Error('Pick a source before continuing.');
        await ensureIssues(selection);
      }
      if (target >= 4) {
        if (selection === null) throw new Error('Pick a source before continuing.');
        await ensureStates(selection);
      }
      if (target >= 5) await ensureReconcile();
      setStep(target);
      setMaxStep((m) => Math.max(m, target));
    } catch (err) {
      setStepError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleContainerPick = (nextId: string): void => {
    if (nextId === containerId) return;
    setContainerId(nextId);
    setNarrows([]);
    setNarrowId(null);
    setLoading(true);
    setStepError(null);
    void loadNarrows(nextId)
      .catch((err: unknown) => setStepError(errorMessage(err)))
      .finally(() => setLoading(false));
  };

  const handleConnect = async (): Promise<void> => {
    if (selection === null) return;
    let selectionJson: TrackerSelectionJson | null = null;
    if (mode === 'assignee') selectionJson = { assigneeIds: selectedAssigneeIds };
    if (mode === 'manual') selectionJson = { issueIds: includedIssues.map((i) => i.externalId) };

    setSubmitting(true);
    setStepError(null);
    try {
      await trpc.cyboflow.tracker.connect.mutate({
        projectId: targetProjectId,
        credentials,
        source: selection,
        sourceLabel,
        selectionMode: mode,
        selectionJson,
        stateMapping: mapping,
        statusSyncMode,
        pullMode,
        pushMode,
        mirrorSubissues,
        conflictMode,
        reconcile: reconcileDecisions,
      });
      onConnected();
      onClose();
    } catch (err) {
      setStepError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  // -------------------------------------------------------------------------
  // Step bodies
  // -------------------------------------------------------------------------

  const renderConnect = (): React.JSX.Element => (
    <div className="flex flex-col items-center gap-4 text-center">
      <ProviderTile mark={meta.mark} size="lg" />
      <Eyebrow>{STEP_EYEBROWS[0]}</Eyebrow>
      <h3 className="text-lg font-bold text-text-primary">Connect {meta.name}</h3>
      <p className="max-w-[430px] text-xs leading-relaxed text-text-secondary">
        Paste a {meta.apiKeyLabel.toLowerCase()}. Cyboflow validates it against {meta.name} before
        anything is stored, and the key never leaves this machine.
      </p>

      <div className={cn(CARD, 'w-full max-w-[440px] space-y-3 p-4 text-left')}>
        <label className="block">
          <Eyebrow className="mb-1.5">{meta.apiKeyLabel}</Eyebrow>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="paste your key"
            aria-label={meta.apiKeyLabel}
            className={trackerInputClass}
          />
          <p className="mt-1 text-[11px] text-text-tertiary">{meta.apiKeyHint}</p>
        </label>

        {meta.needsWorkspaceSlug && (
          <label className="block">
            <Eyebrow className="mb-1.5">Workspace slug</Eyebrow>
            <input
              type="text"
              value={workspaceSlug}
              onChange={(e) => setWorkspaceSlug(e.target.value)}
              placeholder="acme"
              aria-label="Workspace slug"
              className={trackerInputClass}
            />
          </label>
        )}

        {meta.defaultBaseUrl !== null && (
          <label className="block">
            <Eyebrow className="mb-1.5">Instance URL</Eyebrow>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={meta.defaultBaseUrl}
              aria-label="Instance URL"
              className={trackerInputClass}
            />
            <p className="mt-1 text-[11px] text-text-tertiary">
              Leave the default unless you self-host {meta.name}.
            </p>
          </label>
        )}
      </div>

      <div className={cn(CARD, 'w-full max-w-[440px] p-4 text-left')}>
        <Eyebrow className="mb-2 border-b border-dashed border-border-primary pb-2">
          What cyboflow uses
        </Eyebrow>
        <ul className="space-y-1.5">
          {meta.scopes.map((scope) => (
            <li key={scope.label} className="flex items-center gap-2 text-xs text-text-primary">
              <Check className="h-3.5 w-3.5 flex-shrink-0 text-status-success" />
              <span className="lowercase">{scope.label}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-text-tertiary">{meta.scopeFootnote}</p>
      </div>

      {identity === null ? (
        <div className="flex flex-col items-center gap-2">
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="rounded-none"
            disabled={apiKey.trim().length === 0 || validating}
            loading={validating}
            loadingText={`Checking with ${meta.name}…`}
            onClick={() => void handleAuthorize()}
          >
            Authorize
          </Button>
          {authError !== null && (
            <p className="max-w-[440px] text-xs text-status-error" role="alert">
              {authError}
            </p>
          )}
        </div>
      ) : (
        <div
          className="w-full max-w-[440px] rounded-none border border-status-success bg-surface-primary p-4 text-left"
          data-testid="tracker-authorized-card"
        >
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-status-success">
              <Check className="h-3.5 w-3.5 text-text-on-status-success" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text-primary">
                Authorized as {identity.actorLabel}
              </p>
              <p className="mt-0.5 text-xs text-text-secondary">
                workspace {identity.workspaceName}
              </p>
            </div>
          </div>
          <div className="mt-3 flex justify-end">
            <Button
              type="button"
              variant="primary"
              size="sm"
              className="rounded-none"
              loading={loading}
              onClick={() => void goToStep(1)}
            >
              Continue
            </Button>
          </div>
        </div>
      )}
    </div>
  );

  const renderProject = (): React.JSX.Element => (
    <div className="space-y-5">
      <div>
        <Eyebrow>{STEP_EYEBROWS[1]}</Eyebrow>
        <h3 className="mt-1.5 text-lg font-bold text-text-primary">
          Which cyboflow project does this sync into?
        </h3>
        <p className="mt-1.5 max-w-[560px] text-xs leading-relaxed text-text-secondary">
          Imported {meta.name} issues land in this project&apos;s backlog, and only this
          project&apos;s items sync back. One connection maps one cyboflow project to one{' '}
          {meta.name} source — connect again from another project for more mappings.
        </p>
      </div>

      <div className="space-y-1.5">
        {projects.map((p) => {
          const selected = p.id === targetProjectId;
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={selected}
              onClick={() => setTargetProjectId(p.id)}
              className={cn(
                CARD,
                'flex w-full items-center gap-3 px-3 py-2 text-left transition-colors duration-[120ms]',
                selected ? 'border-interactive' : 'hover:border-border-emphasized',
              )}
            >
              <span
                className={cn(
                  'h-2.5 w-2.5 flex-shrink-0 rounded-full border',
                  selected ? 'border-interactive bg-interactive' : 'border-border-primary',
                )}
              />
              <span className="text-xs font-bold text-text-primary">{p.name}</span>
              {p.id === projectId && (
                <span className="rounded-none bg-surface-secondary px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.12em] text-text-tertiary">
                  Active
                </span>
              )}
              <span className="ml-auto min-w-0 truncate text-[11px] text-text-tertiary">
                {p.path}
              </span>
            </button>
          );
        })}
        {projects.length === 0 && (
          <p className={cn(CARD, 'px-3 py-4 text-xs text-text-tertiary')}>
            Project list unavailable — the connection will use the currently active project.
          </p>
        )}
      </div>
    </div>
  );

  const renderSource = (): React.JSX.Element => {
    const containerLabel = sourceTree?.containerLabel ?? 'Source';
    return (
      <div className="space-y-5">
        <div>
          <Eyebrow>{STEP_EYEBROWS[2]}</Eyebrow>
          <h3 className="mt-1.5 text-lg font-bold text-text-primary">
            Pick a {containerLabel.toLowerCase()}, then narrow it down
          </h3>
        </div>

        <div>
          <Eyebrow className="mb-2">{containerLabel}</Eyebrow>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {(sourceTree?.containers ?? []).map((c) => {
              const selected = c.id === containerId;
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => handleContainerPick(c.id)}
                  className={cn(
                    CARD,
                    'flex flex-col items-start gap-1.5 p-3 text-left transition-colors duration-[120ms]',
                    selected ? 'border-interactive shadow-[inset_3px_0_0_var(--color-interactive-primary)]' : 'hover:border-border-emphasized',
                  )}
                >
                  {c.key !== null && (
                    <span
                      className={cn(
                        'rounded-none px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.12em]',
                        selected
                          ? 'bg-interactive text-text-on-interactive'
                          : 'bg-surface-secondary text-text-tertiary',
                      )}
                    >
                      {c.key}
                    </span>
                  )}
                  <span className="text-xs font-bold text-text-primary">{c.name}</span>
                  <span className="text-[11px] text-text-tertiary">
                    {c.openIssueCount === null ? 'open issues' : `${c.openIssueCount} open issues`}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <Eyebrow className="mb-2">Narrow to</Eyebrow>
          <div className="space-y-1.5">
            {narrows.map((n) => {
              const selected = n.id === narrowId;
              return (
                <button
                  key={n.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setNarrowId(n.id)}
                  className={cn(
                    CARD,
                    'flex w-full items-center gap-3 px-3 py-2 text-left transition-colors duration-[120ms]',
                    selected ? 'border-interactive' : 'hover:border-border-emphasized',
                  )}
                >
                  <span
                    className={cn(
                      'h-2.5 w-2.5 flex-shrink-0 rounded-full border',
                      selected ? 'border-interactive bg-interactive' : 'border-border-primary',
                    )}
                  />
                  <span className="text-xs text-text-primary">{n.name}</span>
                  <span className="text-[10px] uppercase tracking-[0.12em] text-text-tertiary">
                    {n.kind}
                  </span>
                  <span className="ml-auto text-[11px] text-text-tertiary">
                    {n.issueCount === null ? '' : `${n.issueCount} issues`}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  const renderTasks = (): React.JSX.Element => {
    const hint =
      mode === 'all'
        ? 'Every issue in the source imports, and new ones keep arriving on each sync.'
        : mode === 'assignee'
          ? 'Only issues assigned to the people you pick import.'
          : 'Only the issues you tick import. New issues will not be added automatically.';

    return (
      <div className="space-y-4">
        <div>
          <Eyebrow>{STEP_EYEBROWS[3]}</Eyebrow>
          <h3 className="mt-1.5 text-lg font-bold text-text-primary">Which issues come in?</h3>
        </div>

        <Segmented
          options={MODE_OPTIONS}
          value={mode}
          onChange={setMode}
          ariaLabel="Issue selection mode"
        />
        <p className="text-xs text-text-secondary">{hint}</p>

        {mode === 'assignee' && (
          <div className="flex flex-wrap gap-2">
            {assigneeOptions.map(({ user, count }) => {
              const on = assignees[user.id] === true;
              return (
                <button
                  key={user.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setAssignees((prev) => ({ ...prev, [user.id]: !on }))}
                  className={cn(
                    'flex items-center gap-2 rounded-none border px-2 py-1 text-[11px] transition-colors duration-[120ms]',
                    on
                      ? 'border-border-emphasized bg-surface-primary text-text-primary'
                      : 'border-border-primary bg-surface-primary text-text-secondary',
                  )}
                >
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-surface-secondary text-[8px] font-bold text-text-secondary">
                    {user.initials}
                  </span>
                  {user.name}
                  <span className="text-text-tertiary">{count}</span>
                  {on && <Check className="h-3 w-3 text-status-success" />}
                </button>
              );
            })}
            {assigneeOptions.length === 0 && (
              <p className="text-xs text-text-tertiary">No assignees on the issues in this source.</p>
            )}
          </div>
        )}

        <div className={CARD}>
          <div className="flex items-center justify-between gap-3 border-b border-border-primary bg-surface-secondary px-3 py-2">
            <Eyebrow>{includedIssues.length} issues will sync</Eyebrow>
            {mode === 'manual' && (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() =>
                    setManual(Object.fromEntries(issues.map((i) => [i.externalId, true])))
                  }
                  className="text-[10px] font-bold uppercase tracking-[0.12em] text-interactive"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={() => setManual({})}
                  className="text-[10px] font-bold uppercase tracking-[0.12em] text-text-tertiary"
                >
                  Clear
                </button>
              </div>
            )}
          </div>
          <ul className="divide-y divide-border-primary">
            {issues.map((issue) => {
              const included = includedIds.has(issue.externalId);
              return (
                <li key={issue.externalId}>
                  <button
                    type="button"
                    disabled={mode !== 'manual'}
                    aria-pressed={mode === 'manual' ? included : undefined}
                    onClick={() =>
                      setManual((prev) => ({ ...prev, [issue.externalId]: !included }))
                    }
                    className={cn(
                      'flex w-full items-center gap-3 px-3 py-2 text-left',
                      mode === 'manual' && !included && 'opacity-50',
                      mode === 'manual' && 'hover:bg-bg-hover',
                    )}
                  >
                    {mode === 'manual' && (
                      <span
                        className={cn(
                          'flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-none border',
                          included
                            ? 'border-interactive bg-interactive'
                            : 'border-border-primary',
                        )}
                      >
                        {included && <Check className="h-2.5 w-2.5 text-text-on-interactive" />}
                      </span>
                    )}
                    <span className="w-16 flex-shrink-0 truncate text-[10px] lowercase text-text-tertiary">
                      {issue.identifier}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-text-primary">
                      {issue.title}
                    </span>
                    {issue.estimate !== null && (
                      <span className="w-8 flex-shrink-0 text-right text-[10px] text-text-tertiary">
                        {issue.estimate} pt
                      </span>
                    )}
                    {issue.assignee !== null && (
                      <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-surface-secondary text-[8px] font-bold text-text-secondary">
                        {issue.assignee.initials}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
            {issues.length === 0 && (
              <li className="px-3 py-4 text-xs text-text-tertiary">
                This source has no open issues.
              </li>
            )}
          </ul>
        </div>
      </div>
    );
  };

  const renderStates = (): React.JSX.Element => (
    <div className="space-y-4">
      <div>
        <Eyebrow>{STEP_EYEBROWS[4]}</Eyebrow>
        <h3 className="mt-1.5 text-lg font-bold text-text-primary">
          Map {meta.name} states to cyboflow
        </h3>
        <p className="mt-1.5 text-xs text-text-secondary">
          Cyboflow has four states. Anything mapped to “Don’t import” is skipped entirely.
        </p>
      </div>

      <div className={CARD}>
        <div className="grid grid-cols-[minmax(0,1fr)_240px] gap-3 border-b border-border-primary bg-surface-secondary px-3 py-2">
          <Eyebrow>{meta.name} state</Eyebrow>
          <Eyebrow>Cyboflow state</Eyebrow>
        </div>
        <div className="divide-y divide-border-primary">
          {states.map((state) => (
            <div
              key={state.id}
              className="grid grid-cols-[minmax(0,1fr)_240px] items-center gap-3 px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-2 w-2 flex-shrink-0 rounded-none bg-text-tertiary"
                  style={state.color !== null ? { backgroundColor: state.color } : undefined}
                />
                <span className="truncate text-xs text-text-primary">{state.name}</span>
                <span className="text-[10px] text-text-tertiary">
                  {stateCounts[state.id] ?? 0}
                </span>
              </div>
              <select
                aria-label={`Cyboflow state for ${state.name}`}
                value={mapping[state.id] ?? 'dont'}
                onChange={(e) =>
                  setMapping((prev) => ({
                    ...prev,
                    // The <select> value is always one of MAPPING_TARGETS, so the
                    // cast below stays inside the TrackerMappingTarget union.
                    [state.id]: e.target.value as TrackerStateMapping[string],
                  }))
                }
                className={cn(trackerSelectClass, 'w-full')}
              >
                {MAPPING_TARGETS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
          {states.length === 0 && (
            <p className="px-3 py-4 text-xs text-text-tertiary">
              {meta.name} returned no workflow states for this source.
            </p>
          )}
        </div>
      </div>

      <div className={cn(CARD, 'p-3')}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-text-primary">Sync task status</p>
            <p className="mt-0.5 text-[11px] text-text-tertiary">
              Status changes on linked items flow both ways.
            </p>
          </div>
          <Segmented
            options={DIRECTION_OPTIONS}
            value={statusSyncMode}
            onChange={setStatusSyncMode}
            ariaLabel="Sync task status"
          />
        </div>

        <ul className="mt-3 space-y-1 border border-border-primary bg-surface-secondary p-3 text-[11px] text-text-secondary">
          <li>Ready for development → nothing (readiness is not started)</li>
          <li>In development → the {meta.name} started state</li>
          <li>Done → the {meta.name} done state</li>
          <li>Won’t do → the {meta.name} cancelled state</li>
        </ul>

        <div className="mt-3 flex items-center justify-between gap-3 border-t border-border-primary pt-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-text-primary">Pull from {meta.name}</p>
            <p className="mt-0.5 text-[11px] text-text-tertiary">
              New {meta.name} issues import as cyboflow ideas.
            </p>
          </div>
          <Segmented
            options={DIRECTION_OPTIONS}
            value={pullMode}
            onChange={setPullMode}
            ariaLabel={`Pull from ${meta.name}`}
          />
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 border-t border-border-primary pt-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-text-primary">Push to {meta.name}</p>
            <p className="mt-0.5 text-[11px] text-text-tertiary">
              New cyboflow ideas are created as {meta.name} issues.
            </p>
          </div>
          <Segmented
            options={DIRECTION_OPTIONS}
            value={pushMode}
            onChange={setPushMode}
            ariaLabel={`Push to ${meta.name}`}
          />
        </div>

        <div className="mt-3 flex items-start gap-3 border-t border-border-primary pt-3">
          <PillToggle
            checked={mirrorSubissues}
            onChange={setMirrorSubissues}
            label="Mirror task breakdowns as sub-issues"
          />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-text-primary">
              Mirror task breakdowns as sub-issues
            </p>
            <p className="mt-0.5 text-[11px] text-text-tertiary">
              When the planner decomposes an imported idea, each task is created as a sub-issue
              and reports its own status back.
            </p>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 border-t border-border-primary pt-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-text-primary">When both sides changed</p>
            <p className="mt-0.5 text-[11px] text-text-tertiary">
              Auto-resolve merges field by field; Manual review queues each conflict for you.
            </p>
          </div>
          <Segmented
            options={CONFLICT_OPTIONS}
            value={conflictMode}
            onChange={setConflictMode}
            ariaLabel="Conflict mode"
          />
        </div>

        <p className="mt-3 border-t border-dashed border-border-primary pt-3 text-[11px] text-text-tertiary">
          Manual directions wait for you to press “Sync now”.
        </p>
      </div>
    </div>
  );

  const renderReconcile = (): React.JSX.Element => {
    const setAll = (action: ReconcileAction): void => {
      setDecisions(Object.fromEntries(reconcileItems.map((i) => [i.entityId, action])));
    };

    return (
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Eyebrow>{STEP_EYEBROWS[5]}</Eyebrow>
            <h3 className="mt-1.5 text-lg font-bold text-text-primary">
              Your existing cyboflow backlog
            </h3>
          </div>
          <div className="flex flex-shrink-0 rounded-none border border-border-primary">
            <button
              type="button"
              onClick={() => setAll('keep')}
              className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-text-secondary hover:text-text-primary"
            >
              Keep all
            </button>
            <button
              type="button"
              onClick={() => setAll('discard')}
              className="border-l border-border-primary px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-text-secondary hover:text-text-primary"
            >
              Discard all
            </button>
          </div>
        </div>

        <p className="text-xs leading-relaxed text-text-secondary">
          You have {reconcileItems.length} items in cyboflow&apos;s backlog from before this
          connection. Decide what happens to each. <strong>Link</strong> merges an item into a
          matching {meta.name} issue so it is not tracked twice.
        </p>

        <div className={CARD}>
          <div className="grid grid-cols-[minmax(0,1fr)_260px] gap-3 border-b border-border-primary bg-surface-secondary px-3 py-2">
            <Eyebrow>Cyboflow backlog item</Eyebrow>
            <Eyebrow>Action</Eyebrow>
          </div>
          <div className="divide-y divide-border-primary">
            {reconcileItems.map((item) => {
              const action = decisions[item.entityId] ?? 'keep';
              const suggestion =
                item.suggestedExternalId === null
                  ? null
                  : includedIssues.find((i) => i.externalId === item.suggestedExternalId) ?? null;
              return (
                <div
                  key={item.entityId}
                  className={cn(
                    'grid grid-cols-[minmax(0,1fr)_260px] items-center gap-3 px-3 py-2',
                    action === 'discard' && 'bg-surface-secondary opacity-60',
                  )}
                >
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[10px] lowercase text-text-tertiary">{item.ref}</span>
                      <span className="truncate text-xs font-semibold text-text-primary">
                        {item.title}
                      </span>
                    </div>
                    {action === 'link' ? (
                      <div className="mt-1.5 flex items-center gap-2">
                        <Eyebrow className="flex-shrink-0">Merge into</Eyebrow>
                        <select
                          aria-label={`Merge ${item.ref} into`}
                          value={linkTargets[item.entityId] ?? ''}
                          onChange={(e) =>
                            setLinkTargets((prev) => ({ ...prev, [item.entityId]: e.target.value }))
                          }
                          className={cn(trackerSelectClass, 'min-w-0 flex-1')}
                        >
                          {includedIssues.map((issue) => (
                            <option key={issue.externalId} value={issue.externalId}>
                              {issue.identifier} · {issue.title}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : (
                      suggestion !== null && (
                        <p className="mt-1 truncate text-[11px] text-interactive">
                          likely match · {suggestion.identifier} · {suggestion.title}
                        </p>
                      )
                    )}
                  </div>
                  <Segmented
                    options={RECONCILE_OPTIONS}
                    value={action}
                    ariaLabel={`Action for ${item.ref}`}
                    onChange={(next) => {
                      setDecisions((prev) => ({ ...prev, [item.entityId]: next }));
                      if (next === 'link') {
                        setLinkTargets((prev) =>
                          prev[item.entityId] !== undefined
                            ? prev
                            : {
                                ...prev,
                                [item.entityId]:
                                  item.suggestedExternalId ??
                                  includedIssues[0]?.externalId ??
                                  '',
                              },
                        );
                      }
                    }}
                  />
                </div>
              );
            })}
            {reconcileItems.length === 0 && (
              <p className="px-3 py-4 text-xs text-text-tertiary">
                Nothing was in this project&apos;s backlog before the connection.
              </p>
            )}
          </div>
        </div>

        <p className="text-[11px] text-text-tertiary">
          <span className="text-status-success">{tally.keep} kept</span> ·{' '}
          <span className="text-interactive">{tally.link} linked</span> · {tally.discard} discarded
        </p>
      </div>
    );
  };

  const renderReview = (): React.JSX.Element => {
    const selectionDetail =
      mode === 'all'
        ? 'Every issue in the source'
        : mode === 'assignee'
          ? `${selectedAssigneeIds.length} assignees`
          : `${includedIssues.length} hand-picked issues`;

    const cards: { label: string; value: string; detail: string }[] = [
      {
        label: 'Cyboflow project',
        value: targetProjectName,
        detail: 'Issues import into this backlog',
      },
      { label: 'Source', value: sourceLabel, detail: meta.name },
      {
        label: 'Selection',
        value: MODE_OPTIONS.find((m) => m.value === mode)?.label ?? mode,
        detail: selectionDetail,
      },
      {
        label: 'Direction',
        value: `Status ${directionLabel(statusSyncMode)} · Pull ${directionLabel(pullMode)} · Push ${directionLabel(pushMode)}`,
        detail: `${mirrorSubissues ? 'Sub-issue mirroring on' : 'Sub-issue mirroring off'} · conflicts ${
          conflictMode === 'auto' ? 'auto-resolve' : 'queue for review'
        }`,
      },
      {
        label: 'Mapping',
        value: `${states.length - skippedStates.length} of ${states.length} states mapped`,
        detail:
          skippedStates.length === 0
            ? 'Nothing skipped'
            : `Skipped: ${skippedStates.map((s) => s.name).join(', ')}`,
      },
    ];

    return (
      <div className="space-y-4">
        <div>
          <Eyebrow>{STEP_EYEBROWS[6]}</Eyebrow>
          <h3 className="mt-1.5 text-lg font-bold text-text-primary">Review the connection</h3>
          <p className="mt-1.5 text-xs text-text-secondary">
            {includedIssues.length} issues will import as ideas now. Ongoing changes sync every 5
            minutes.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {cards.map((card) => (
            <div key={card.label} className={cn(CARD, 'p-3')}>
              <Eyebrow>{card.label}</Eyebrow>
              <p className="mt-1.5 text-xs font-semibold text-text-primary">{card.value}</p>
              <p className="mt-0.5 text-[11px] text-text-tertiary">{card.detail}</p>
            </div>
          ))}
        </div>

        <div className={cn(CARD, 'p-3')}>
          <Eyebrow>Existing backlog</Eyebrow>
          <p className="mt-1.5 text-xs text-text-primary">
            {tally.keep} kept in cyboflow · {tally.link} linked to {meta.name} · {tally.discard}{' '}
            discarded
          </p>
        </div>

        <div className="flex justify-end">
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="rounded-none"
            loading={submitting}
            loadingText="Connecting…"
            onClick={() => void handleConnect()}
          >
            Connect &amp; sync {includedIssues.length} issues
          </Button>
        </div>
      </div>
    );
  };

  const stepBodies = [
    renderConnect,
    renderProject,
    renderSource,
    renderTasks,
    renderStates,
    renderReconcile,
    renderReview,
  ];

  // -------------------------------------------------------------------------
  // Chrome
  // -------------------------------------------------------------------------

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="full"
      showCloseButton={false}
      closeOnOverlayClick={false}
      className="rounded-none"
    >
      <div
        className="flex flex-col"
        style={{ height: '90vh', maxHeight: '90vh' }}
        data-testid="tracker-wizard-modal"
      >
        {/* ── Head ────────────────────────────────────────────────────────── */}
        <div className="flex flex-shrink-0 items-center gap-3 border-b border-border-primary bg-surface-secondary px-4 py-2.5">
          <Eyebrow className="text-text-primary">Integrations</Eyebrow>
          <span className="text-[10px] uppercase tracking-[0.18em] text-text-tertiary">
            / Connect {meta.name}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-none border border-border-primary px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-text-secondary hover:text-text-primary"
          >
            Close
          </button>
        </div>

        {/* ── Step rail ───────────────────────────────────────────────────── */}
        <div className="flex flex-shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border-primary bg-surface-secondary px-4">
          {STEP_LABELS.map((label, index) => {
            const active = index === step;
            const past = index < step;
            const reachable = index <= maxStep;
            return (
              <button
                key={label}
                type="button"
                disabled={!reachable}
                aria-current={active ? 'step' : undefined}
                data-testid={`tracker-step-${index}`}
                onClick={() => void goToStep(index)}
                className={cn(
                  'flex items-center gap-2 px-3 py-2.5 text-[10px] font-bold uppercase tracking-[0.12em] transition-colors duration-[120ms]',
                  active && 'text-text-primary shadow-[inset_0_-2px_0_var(--color-interactive-primary)]',
                  !active && past && 'text-text-secondary',
                  !active && !past && 'text-text-tertiary',
                  !reachable && 'cursor-not-allowed',
                )}
              >
                <span
                  className={cn(
                    'flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px]',
                    active
                      ? 'bg-interactive text-text-on-interactive'
                      : past
                        ? 'bg-text-secondary text-bg-primary'
                        : 'bg-surface-tertiary text-text-tertiary',
                  )}
                >
                  {index + 1}
                </span>
                {label}
              </button>
            );
          })}
        </div>

        {/* ── Body ────────────────────────────────────────────────────────── */}
        <div className="min-h-0 flex-1 overflow-y-auto bg-bg-primary px-6 py-5">
          <div className="mx-auto w-full max-w-[840px]">
            {stepError !== null && (
              <p
                role="alert"
                className="mb-3 rounded-none border border-status-error px-3 py-2 text-xs text-status-error"
              >
                {stepError}
              </p>
            )}
            {stepBodies[step]()}
          </div>
        </div>

        {/* ── Footer nav (steps 1–6; Step 0 advances from its own card) ───── */}
        {step > 0 && (
          <div className="flex flex-shrink-0 items-center justify-between gap-3 border-t border-dashed border-border-primary bg-bg-primary px-6 py-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="rounded-none"
              onClick={() => void goToStep(step - 1)}
            >
              Back
            </Button>
            <div className="flex items-center gap-3">
              <span className="text-[10px] uppercase tracking-[0.12em] text-text-tertiary">
                Step {step + 1} of {STEP_LABELS.length}
              </span>
              {step < LAST_STEP && (
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  className="rounded-none"
                  disabled={nextBlocked || loading}
                  loading={loading}
                  onClick={() => void goToStep(step + 1)}
                >
                  {step === LAST_STEP - 1 ? 'Review' : 'Continue'}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
