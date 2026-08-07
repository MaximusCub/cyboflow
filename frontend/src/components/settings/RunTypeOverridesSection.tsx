/**
 * RunTypeOverridesSection — the "Session type overrides" sub-block of Settings →
 * AI → Session settings, sitting directly below "Global defaults".
 *
 * A grouped inventory of every session type (built-in flows · quick sessions ·
 * custom flows, project-scoped ones grouped under their project) with a
 * `Following defaults` / `N overrides` badge, chips for ONLY the values that
 * differ from the global defaults, and a `Configure ›` CTA that swaps the list
 * for {@link RunTypeOverrideDetail}.
 *
 * Unlike its sibling groups this is a SELF-FETCHING panel (the
 * `IntegrationsSettings` pattern), not a props-in/callback-out container: its
 * writes go through the dedicated `configStore.applyRunTypeDefault` IPC op, NOT
 * `Settings.tsx`'s shared `handleSubmit` — see the RunTypeOverrideDetail module
 * doc for why routing it through the shared form would clobber concurrent
 * launch-screen writes.
 *
 * The live workflow rows come from `useWorkflowsStore`, which already does the
 * per-project `workflows.list` fan-out, dedupes by `row.id` (a GLOBAL flow is
 * returned by every project), and resolves each row's owning `projectName`. Its
 * bootstrap is fire-and-forget: a failure leaves the list showing the quick row
 * plus whatever keys are already stored, which is strictly better than blocking
 * the whole Settings tab on a gallery fetch.
 */
import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Layers } from 'lucide-react';
import { useConfigStore } from '../../stores/configStore';
import { useWorkflowsStore } from '../../stores/workflowsStore';
import { RunTypeOverrideDetail } from './RunTypeOverrideDetail';
import {
  buildRunTypeGroups,
  resolveRunTypeBaseline,
  runTypeOverrideChips,
  runTypeStatusLabel,
  type RunTypeRow,
} from './runTypeOverrides';

export function RunTypeOverridesSection(): React.JSX.Element {
  const config = useConfigStore((s) => s.config);
  const workflows = useWorkflowsStore((s) => s.workflows);
  const initWorkflows = useWorkflowsStore((s) => s.init);
  const [selected, setSelected] = useState<RunTypeRow | null>(null);

  // Fire-and-forget bootstrap. Wrapped so BOTH a synchronous throw and a
  // rejected fan-out are swallowed here: a Settings tab must never surface an
  // unhandled rejection because the workflows gallery could not be enumerated.
  useEffect(() => {
    void Promise.resolve()
      .then(() => initWorkflows())
      .catch(() => {
        /* list degrades to the quick row + stored keys */
      });
  }, [initWorkflows]);

  const runTypeDefaults = config?.runTypeDefaults;

  const groups = useMemo(
    () =>
      buildRunTypeGroups(
        workflows ?? [],
        runTypeDefaults === undefined ? [] : Object.keys(runTypeDefaults),
      ),
    [workflows, runTypeDefaults],
  );

  if (selected !== null) {
    return (
      <section aria-labelledby="session-settings-run-type-overrides" className="mt-8">
        <h4
          id="session-settings-run-type-overrides"
          className="text-xs font-semibold uppercase tracking-[.08em] text-text-tertiary mb-4"
        >
          Session type overrides
        </h4>
        <RunTypeOverrideDetail
          runTypeKey={selected.key}
          title={selected.label}
          subtitle={selected.sublabel}
          stored={runTypeDefaults?.[selected.key]}
          baseline={resolveRunTypeBaseline(selected.key, config)}
          onClose={() => setSelected(null)}
        />
      </section>
    );
  }

  return (
    <section
      aria-labelledby="session-settings-run-type-overrides"
      className="mt-8"
      data-testid="run-type-overrides"
    >
      <h4
        id="session-settings-run-type-overrides"
        className="text-xs font-semibold uppercase tracking-[.08em] text-text-tertiary mb-4"
      >
        Session type overrides
      </h4>
      <div className="flex items-start gap-3 mb-4">
        <div className="flex-shrink-0 mt-0.5 text-interactive">
          <Layers className="w-4 h-4" />
        </div>
        <p className="text-xs text-text-tertiary leading-relaxed">
          Per-session-type overrides of the global defaults above. A type with no
          override follows the defaults; only the values that actually differ are
          listed.
        </p>
      </div>

      <div className="flex flex-col gap-5">
        {groups.map((group) => (
          <div key={group.id}>
            <div className="text-xs font-medium text-text-secondary mb-2">{group.title}</div>
            <div className="flex flex-col gap-1.5">
              {group.rows.map((row) => {
                const chips = runTypeOverrideChips(
                  runTypeDefaults?.[row.key],
                  resolveRunTypeBaseline(row.key, config),
                );
                return (
                  <div
                    key={row.key}
                    data-testid={`run-type-row-${row.key}`}
                    className="flex items-start justify-between gap-3 px-3 py-2 rounded-button border border-border-secondary bg-surface-secondary"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-text-primary">{row.label}</span>
                        <span
                          data-testid={`run-type-status-${row.key}`}
                          className={`text-xs px-1.5 py-0.5 rounded-full border ${
                            chips.length === 0
                              ? 'border-border-secondary text-text-tertiary'
                              : 'border-interactive text-interactive'
                          }`}
                        >
                          {runTypeStatusLabel(chips.length)}
                        </span>
                      </div>
                      {row.sublabel !== '' && (
                        <p className="text-xs text-text-tertiary mt-0.5">{row.sublabel}</p>
                      )}
                      {chips.length > 0 && (
                        <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                          {chips.map((chip) => (
                            <span
                              key={chip.field}
                              data-testid={`run-type-chip-${row.key}-${chip.field}`}
                              className="text-xs px-1.5 py-0.5 rounded-full border border-border-secondary text-text-secondary"
                              title={
                                chip.baseline === null
                                  ? `${chip.label}: no global default`
                                  : `${chip.label}: default is ${chip.baseline}`
                              }
                            >
                              {chip.label}: {chip.value}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      aria-label={`Configure ${row.label}`}
                      onClick={() => setSelected(row)}
                      className="shrink-0 inline-flex items-center gap-0.5 text-xs text-interactive hover:text-text-primary transition-colors"
                    >
                      Configure
                      <ChevronRight className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
