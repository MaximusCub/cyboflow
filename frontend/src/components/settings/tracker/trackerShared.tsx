/**
 * The four presentation primitives the Settings → Integrations tracker surface
 * leans on: the uppercase eyebrow label, the square provider plate, the pill
 * switch, and the square segmented control.
 *
 * Copy, mapping defaults and marker colours live next door in
 * trackerVocabulary.ts so neither file mixes component with non-component
 * exports.
 */
import React from 'react';
import { cn } from '../../../utils/cn';

/** Uppercase, wide-tracked step/section label. */
export function Eyebrow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'text-[10px] font-bold uppercase tracking-[0.18em] text-text-tertiary',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Square provider plate: a text mark, never an emoji or a raster brand asset. */
export function ProviderTile({
  mark,
  size = 'md',
}: {
  mark: string;
  size?: 'sm' | 'md' | 'lg';
}): React.JSX.Element {
  const sizes = {
    sm: 'h-7 w-7 text-[9px]',
    md: 'h-9 w-9 text-[10px]',
    lg: 'h-12 w-12 text-xs',
  };
  return (
    <div
      aria-hidden="true"
      className={cn(
        'flex flex-shrink-0 items-center justify-center rounded-none border border-border-primary bg-surface-secondary font-bold uppercase tracking-[0.12em] text-interactive',
        sizes[size],
      )}
    >
      {mark}
    </div>
  );
}

export interface PillToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name — the visible label sits outside the control. */
  label: string;
  disabled?: boolean;
}

/** Rounded pill switch (one of the few deliberately non-square controls). */
export function PillToggle({
  checked,
  onChange,
  label,
  disabled = false,
}: PillToggleProps): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-4 w-8 flex-shrink-0 rounded-full border transition-colors duration-[120ms]',
        checked
          ? 'border-status-success bg-status-success'
          : 'border-border-primary bg-surface-secondary',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-3 w-3 rounded-full bg-bg-primary transition-all duration-[120ms]',
          checked ? 'left-[18px]' : 'left-0.5',
        )}
      />
    </button>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Fill applied when this option is the selected one; defaults to the accent. */
  selectedClass?: string;
}

export interface SegmentedProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
  className?: string;
}

/** Square segmented control — the mode switch (Step 2) and the Keep/Link/Discard ruling (Step 4). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: SegmentedProps<T>): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex rounded-none border border-border-primary bg-surface-primary',
        className,
      )}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              'flex-1 whitespace-nowrap px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] transition-colors duration-[120ms]',
              index > 0 && 'border-l border-border-primary',
              selected
                ? (option.selectedClass ?? 'bg-interactive text-text-on-interactive')
                : 'text-text-secondary hover:text-text-primary',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
