/**
 * overviewChrome — the small shared presentational primitives the three Project
 * Overview sections all repeat: the section header row (dot swatch + title +
 * count pill + descriptor + optional right-aligned link), the dashed empty
 * well, the 13px square selection checkbox, and the two pill flavours.
 *
 * Extracted into its own module rather than living on ProjectOverviewPage so
 * the section components can import it without a cycle back into the page.
 *
 * Colors are SEMANTIC tokens throughout, except the section dot — the design
 * gives each section its own hue (terracotta / human-amber / phase-plan blue)
 * and those are theme-wide CSS variables, so the caller passes a `var(--…)`
 * string that becomes an inline backgroundColor (the same escape hatch
 * FlowProgress and KanbanView already use for phase/stage colors).
 */
import type { LucideIcon } from 'lucide-react';

// ---------------------------------------------------------------------------
// Section header
// ---------------------------------------------------------------------------

export interface SectionHeaderProps {
  /** CSS color for the leading dot — a `var(--…)` token reference, never a raw hex. */
  dotColor: string;
  title: string;
  /** Count pill contents; omitted when undefined. */
  count?: number;
  /** Muted one-liner after the pill. */
  descriptor?: string;
  /** Right-aligned affordance (a link-styled button). */
  action?: { label: string; onClick: () => void };
}

export function SectionHeader({
  dotColor,
  title,
  count,
  descriptor,
  action,
}: SectionHeaderProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: dotColor }}
      />
      <h2 className="font-bold text-text-primary" style={{ fontSize: '13px' }}>
        {title}
      </h2>
      {count !== undefined && (
        <span
          className="rounded-full bg-surface-sunken px-2 text-text-secondary"
          style={{ fontSize: '10px', lineHeight: '16px' }}
        >
          {count}
        </span>
      )}
      {descriptor !== undefined && (
        <span className="truncate text-text-muted" style={{ fontSize: '11px' }}>
          {descriptor}
        </span>
      )}
      {action !== undefined && (
        <button
          type="button"
          onClick={action.onClick}
          className="ml-auto shrink-0 text-interactive hover:text-interactive-hover"
          style={{ fontSize: '11px' }}
        >
          {action.label} →
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashed empty well
// ---------------------------------------------------------------------------

export interface EmptyWellProps {
  icon: LucideIcon;
  title: string;
  hint: string;
  /** At most one link, per the design. */
  action?: { label: string; onClick: () => void };
  /** Extra vertical padding for the page-level (rather than sub-list) wells. */
  tall?: boolean;
  testId?: string;
}

export function EmptyWell({
  icon: Icon,
  title,
  hint,
  action,
  tall = false,
  testId,
}: EmptyWellProps): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      className={`flex flex-col items-center gap-1.5 border border-dashed border-border-primary px-4 text-center ${
        tall ? 'py-8' : 'py-7'
      }`}
    >
      <Icon className="h-[18px] w-[18px] text-text-muted" strokeWidth={1.8} aria-hidden="true" />
      <div className="font-semibold text-text-secondary" style={{ fontSize: '12px' }}>
        {title}
      </div>
      <div className="max-w-xl text-text-muted" style={{ fontSize: '11px' }}>
        {hint}
      </div>
      {action !== undefined && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-1 text-interactive hover:text-interactive-hover"
          style={{ fontSize: '11px' }}
        >
          {action.label} →
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Selection checkbox — the 13px square idiom shared by the idea + task rows
// ---------------------------------------------------------------------------

export interface SelectCheckboxProps {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  /** Accessible name — the row's title, so the checkbox is addressable in tests. */
  label: string;
  testId?: string;
}

export function SelectCheckbox({
  checked,
  disabled = false,
  onChange,
  label,
  testId,
}: SelectCheckboxProps): React.JSX.Element {
  return (
    <span className="relative inline-flex h-[13px] w-[13px] shrink-0 items-center justify-center">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        aria-label={label}
        data-testid={testId}
        className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed"
      />
      <span
        aria-hidden="true"
        className={`pointer-events-none flex h-[13px] w-[13px] items-center justify-center border ${
          checked
            ? 'border-interactive-hover bg-interactive'
            : disabled
              ? 'border-border-primary bg-bg-tertiary'
              : 'border-border-primary bg-surface-primary'
        }`}
      >
        {checked && (
          <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor">
            <polyline
              points="20 6 9 17 4 12"
              strokeWidth={3.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-text-on-interactive"
            />
          </svg>
        )}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Pills
// ---------------------------------------------------------------------------

/** Rust-outlined "N in flow" / "in flow" pill. */
export function FlowPill({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span
      className="shrink-0 rounded-full border border-interactive bg-interactive-surface px-2 text-interactive"
      style={{ fontSize: '10px', lineHeight: '16px' }}
    >
      {children}
    </span>
  );
}

/** Amber-outlined "N awaiting review" pill. */
export function ReviewPill({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span
      className="shrink-0 rounded-full border border-status-warning bg-status-warning/10 px-2 text-status-warning"
      style={{ fontSize: '10px', lineHeight: '16px' }}
    >
      {children}
    </span>
  );
}

/** The uppercase sub-list label ("Top ideas", "Next up · Ready for development"). */
export function ListLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="eyebrow text-text-muted">{children}</div>;
}
