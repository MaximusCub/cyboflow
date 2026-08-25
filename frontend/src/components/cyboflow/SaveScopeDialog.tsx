/**
 * SaveScopeDialog — where an Advanced-editor save LANDS.
 *
 * Originally the two-way global/project-copy choice (migration 030); the tuning
 * levels work (plan `docs/plans/workflow-tuning-levels.md` D3) turned it into
 * the save-target prompt, because customization and A/B now share one entry
 * point and the blast radius has to be an explicit choice at save time:
 *
 *   - "Overwrite this flow"              → `onConfirm({ scope: 'global' })`
 *     Writes the edited graph into the flow's CUSTOM slot (`updateSpec`, which
 *     stamps `tuning_level='custom'` server-side). The only option that changes
 *     what the flow runs by default.
 *   - "Create a project-specific copy"   → `onConfirm({ scope: 'project', projectId })`
 *   - "Save as new flow"                 → `onConfirm({ scope: 'new-flow' })`
 *   - "Save as new variant of this flow" → `onConfirm({ scope: 'new-variant', label })`
 *     Mints a DRAFT variant carrying the edited graph; the base flow and its
 *     level stamp are untouched.
 *
 * Overwrite is the DEFAULT / primary action. For the project-copy path a target
 * project is required: when a project is already in context (a gallery
 * project-filter, or a single enumerated project) it is preselected; in the
 * cross-project "All projects" view a `<select>` picker is shown (mirroring
 * {@link WorkflowsProjectFilter}). The variant path needs a label, collected by
 * an inline input for the same reason the project picker is inline — a second
 * stacked dialog to answer one question reads as a mis-click.
 *
 * The picker uses a plain styled native `<select>` over Radix to inherit the
 * surrounding mono font, like the gallery's own filter. Follows FlowNameDialog's
 * Modal pattern (portal to body, paper theme, Enter/Esc handled by Modal).
 */
import { useEffect, useState } from 'react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../ui/Modal';

/** A project the copy can target — the minimal shape the picker needs. */
export interface SaveScopeProject {
  id: number;
  name: string;
}

/** The chosen save target returned to the editor. */
export type SaveScopeChoice =
  | { scope: 'global' }
  | { scope: 'project'; projectId: number }
  | { scope: 'new-flow' }
  | { scope: 'new-variant'; label: string };

export interface SaveScopeDialogProps {
  isOpen: boolean;
  /**
   * Projects available as a fork target. When this has 0 entries the
   * project-copy path is disabled (only "Save globally" is selectable).
   */
  projects: SaveScopeProject[];
  /**
   * The project preselected for the copy path: the active gallery filter, or the
   * lone enumerated project. `null` ⇒ no project in context (All-projects view),
   * so the picker opens unselected and the user must choose.
   */
  defaultProjectId: number | null;
  /**
   * Does the flow's custom slot already hold a definition? Only affects copy:
   * overwriting then REPLACES an existing Custom definition rather than filling
   * an empty slot, which is worth saying before the click, not after.
   */
  hasCustomDefinition?: boolean;
  onConfirm: (choice: SaveScopeChoice) => void;
  onClose: () => void;
}

type SaveTarget = SaveScopeChoice['scope'];

export function SaveScopeDialog({
  isOpen,
  projects,
  defaultProjectId,
  hasCustomDefinition = false,
  onConfirm,
  onClose,
}: SaveScopeDialogProps): React.JSX.Element {
  const [scope, setScope] = useState<SaveTarget>('global');
  const [projectId, setProjectId] = useState<number | null>(defaultProjectId);
  const [variantLabel, setVariantLabel] = useState('');

  // Re-seed each time the dialog (re)opens so a stale prior selection never
  // leaks into a fresh open. Default = Overwrite this flow (the product decision).
  useEffect(() => {
    if (isOpen) {
      setScope('global');
      setProjectId(defaultProjectId);
      setVariantLabel('');
    }
  }, [isOpen, defaultProjectId]);

  const canCopy = projects.length > 0;
  // The project-copy path needs a resolved target. With no project in context
  // (All-projects) the user must pick one in the select before confirming.
  const projectChoiceValid = projectId !== null && projects.some((p) => p.id === projectId);
  const confirmDisabled =
    (scope === 'project' && !projectChoiceValid) ||
    (scope === 'new-variant' && variantLabel.trim().length === 0);

  const handleConfirm = (): void => {
    if (scope === 'global') {
      onConfirm({ scope: 'global' });
      return;
    }
    if (scope === 'new-flow') {
      onConfirm({ scope: 'new-flow' });
      return;
    }
    if (scope === 'new-variant') {
      const trimmed = variantLabel.trim();
      if (trimmed.length === 0) return;
      onConfirm({ scope: 'new-variant', label: trimmed });
      return;
    }
    if (projectId === null) return;
    onConfirm({ scope: 'project', projectId });
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm">
      <ModalHeader>Save workflow</ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-3">
          {/* Option 1 — Overwrite this flow (default / primary). */}
          <label
            className="flex cursor-pointer items-start gap-2.5 rounded-input border border-border-primary bg-bg-primary p-2.5"
            data-testid="save-scope-global-option"
          >
            <input
              type="radio"
              name="save-scope"
              checked={scope === 'global'}
              onChange={() => setScope('global')}
              className="mt-0.5"
              data-testid="save-scope-global-radio"
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-text-primary">Overwrite this flow</span>
              <span className="text-xs text-text-tertiary">
                {hasCustomDefinition
                  ? 'Replaces your existing Custom definition and selects Custom for this flow.'
                  : 'Saves the edited graph as this flow’s Custom definition and selects it.'}
              </span>
            </span>
          </label>

          {/* Option 2 — Create a project-specific copy. */}
          <label
            className={
              'flex items-start gap-2.5 rounded-input border border-border-primary bg-bg-primary p-2.5 ' +
              (canCopy ? 'cursor-pointer' : 'cursor-not-allowed opacity-50')
            }
            data-testid="save-scope-project-option"
          >
            <input
              type="radio"
              name="save-scope"
              checked={scope === 'project'}
              disabled={!canCopy}
              onChange={() => setScope('project')}
              className="mt-0.5"
              data-testid="save-scope-project-radio"
            />
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium text-text-primary">
                Create a project-specific copy
              </span>
              <span className="text-xs text-text-tertiary">
                Fork into a new flow scoped to one project; this flow is left unchanged.
              </span>
              {scope === 'project' && canCopy && (
                <select
                  aria-label="Target project for the copy"
                  data-testid="save-scope-project-select"
                  value={projectId === null ? '' : String(projectId)}
                  onChange={(e) =>
                    setProjectId(e.target.value === '' ? null : Number(e.target.value))
                  }
                  className="mt-1 rounded-button border border-border-primary bg-bg-primary px-2.5 py-1 font-mono text-xs text-text-secondary transition-colors hover:border-border-emphasized hover:text-text-primary focus:border-border-emphasized focus:outline-none"
                >
                  <option value="">Choose a project…</option>
                  {projects.map((project) => (
                    <option key={project.id} value={String(project.id)}>
                      {project.name}
                    </option>
                  ))}
                </select>
              )}
            </span>
          </label>

          {/* Option 3 — Save as a brand-new flow (name collected next). */}
          <label
            className="flex cursor-pointer items-start gap-2.5 rounded-input border border-border-primary bg-bg-primary p-2.5"
            data-testid="save-scope-new-flow-option"
          >
            <input
              type="radio"
              name="save-scope"
              checked={scope === 'new-flow'}
              onChange={() => setScope('new-flow')}
              className="mt-0.5"
              data-testid="save-scope-new-flow-radio"
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-text-primary">Save as new flow</span>
              <span className="text-xs text-text-tertiary">
                Mint a separate flow from the edited graph; this flow is left unchanged.
              </span>
            </span>
          </label>

          {/* Option 4 — Save as a DRAFT variant carrying the edited graph. */}
          <label
            className="flex cursor-pointer items-start gap-2.5 rounded-input border border-border-primary bg-bg-primary p-2.5"
            data-testid="save-scope-new-variant-option"
          >
            <input
              type="radio"
              name="save-scope"
              checked={scope === 'new-variant'}
              onChange={() => setScope('new-variant')}
              className="mt-0.5"
              data-testid="save-scope-new-variant-radio"
            />
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium text-text-primary">
                Save as new variant of this flow
              </span>
              <span className="text-xs text-text-tertiary">
                Freeze the edited graph as a draft variant for A/B; this flow and its tuning level
                are left unchanged.
              </span>
              {scope === 'new-variant' && (
                <input
                  type="text"
                  aria-label="Variant label"
                  data-testid="save-scope-variant-label"
                  value={variantLabel}
                  onChange={(e) => setVariantLabel(e.target.value)}
                  placeholder="variant label"
                  className="mt-1 rounded-button border border-border-primary bg-bg-primary px-2.5 py-1 font-mono text-xs text-text-primary focus:border-border-emphasized focus:outline-none"
                />
              )}
            </span>
          </label>
        </div>
      </ModalBody>
      <ModalFooter>
        <button
          type="button"
          onClick={onClose}
          className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-hover"
          data-testid="save-scope-cancel"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={confirmDisabled}
          className="rounded-button bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="save-scope-confirm"
        >
          Save
        </button>
      </ModalFooter>
    </Modal>
  );
}
