/**
 * WorkingSection — the accent band: agents that are running and need nothing.
 *
 * Deliberately the calmest section on the page. Rows are one line, the only
 * motion is the pulsing dot, and there is no action beyond opening the session —
 * anything that needed you would have surfaced in "Needs your input" instead.
 *
 * Three sources merge here: active flow runs, quick sessions the triage classes
 * as running, and detected dynamic workflows. The last two overlap by design
 * (deriveQuickSessionTriage promotes a session with a live dynamic workflow to
 * `running`), so the page dedupes dynamic workflows against the quick rows
 * before handing them over.
 */
import React from 'react';
import type { QuickSessionRow } from '../../../../shared/types/quickSessions';
import type { DynamicWorkflowRunState } from '../../../../shared/types/dynamicWorkflows';
import type { ActiveRunRow } from '../../stores/activeRunsStore';
import { EmptyStrip, SectionHeader } from './QueuePrimitives';

/** One running thing, normalized across the three sources. */
export type WorkingRow =
  | { kind: 'quick'; id: string; row: QuickSessionRow }
  | { kind: 'run'; id: string; run: ActiveRunRow }
  | { kind: 'dynamic'; id: string; workflow: DynamicWorkflowRunState };

function describe(entry: WorkingRow): { name: string; detail: string | null } {
  switch (entry.kind) {
    case 'quick':
      return { name: entry.row.name, detail: entry.row.summary };
    case 'run':
      return { name: entry.run.workflowName, detail: entry.run.branch_name };
    case 'dynamic':
      return {
        name: entry.workflow.sessionName,
        detail: entry.workflow.description ?? entry.workflow.name,
      };
  }
}

function Row({ entry, onOpen }: { entry: WorkingRow; onOpen: () => void }): React.JSX.Element {
  const { name, detail } = describe(entry);
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="rq-working-row"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="flex w-full cursor-pointer items-center gap-2.5 border border-border-primary bg-surface-primary px-3.5 py-2 text-left transition-colors hover:border-border-hover"
    >
      <span
        aria-hidden="true"
        className="h-[7px] w-[7px] shrink-0 animate-cfpulse rounded-full bg-interactive"
      />
      <span className="shrink-0 text-[12px] font-bold text-text-primary">{name}</span>
      {detail !== null && (
        <span className="min-w-0 flex-1 truncate text-[11px] text-text-secondary" title={detail}>
          {detail}
        </span>
      )}
      <span className="eyebrow ml-auto shrink-0 rounded-full border border-border-primary px-2 py-px text-text-secondary">
        Running
      </span>
    </div>
  );
}

export interface WorkingSectionProps {
  rows: WorkingRow[];
  /** Render an empty dashed strip instead of hiding the section (the all-idle state). */
  showWhenEmpty: boolean;
  onOpenQuickSession: (row: QuickSessionRow) => void;
  onOpenRun: (run: ActiveRunRow) => void;
  onOpenDynamicWorkflow: (workflow: DynamicWorkflowRunState) => void;
}

/** WorkingSection — see {@link WorkingSectionProps}. */
export function WorkingSection({
  rows,
  showWhenEmpty,
  onOpenQuickSession,
  onOpenRun,
  onOpenDynamicWorkflow,
}: WorkingSectionProps): React.JSX.Element | null {
  if (rows.length === 0 && !showWhenEmpty) return null;
  return (
    <section data-testid="rq-working-section" className="flex flex-col gap-2">
      <SectionHeader
        dotClass="bg-interactive"
        title="Working"
        count={rows.length}
        countMuted={rows.length === 0}
        subtitle={rows.length > 0 ? 'Running — nothing needed from you' : undefined}
      />
      {rows.length === 0 ? (
        <EmptyStrip>No agents running.</EmptyStrip>
      ) : (
        rows.map((entry) => (
          <Row
            key={entry.id}
            entry={entry}
            onOpen={() => {
              if (entry.kind === 'quick') onOpenQuickSession(entry.row);
              else if (entry.kind === 'run') onOpenRun(entry.run);
              else onOpenDynamicWorkflow(entry.workflow);
            }}
          />
        ))
      )}
    </section>
  );
}
