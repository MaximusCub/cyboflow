/**
 * DesignCard — the featured "Design" card shown in the wizard's workflow step,
 * alongside the quick-session and Ultracode cards (design-mode.md "UX
 * walkthrough" step 1 — the wizard's `WizardSelection` union grows a 4th arm).
 *
 * Selecting it does NOT launch immediately: it opens the idea picker (an
 * idea link is required — see SessionStartWizard's handleStart design arm),
 * then starts a quick-session variant hard-pinned to the Claude SDK substrate
 * (design-mode.md "Session plumbing" — a security boundary, not a preference)
 * with the chosen idea threaded as `designIdeaId`.
 *
 * Visually mirrors {@link QuickSessionCard} / {@link UltracodeCard} (cream
 * card, terracotta border, dark diagonal-hatch tab) with a distinct glyph so
 * it reads as a peer of the other featured launchers.
 */

interface DesignCardProps {
  selected: boolean;
  onSelect: () => void;
}

/** The dark diagonal-hatch tab fill — matches QuickSessionCard/UltracodeCard. */
const HATCH_TAB_STYLE: React.CSSProperties = {
  backgroundImage:
    'repeating-linear-gradient(135deg, #1a1815 0 7px, #3a3530 7px 14px)',
};

export function DesignCard({
  selected,
  onSelect,
}: DesignCardProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid="design-card"
      aria-pressed={selected}
      className={`flex w-full flex-col overflow-hidden border bg-bg-secondary text-left transition-colors ${
        selected ? 'border-2 border-interactive' : 'border border-interactive'
      }`}
    >
      {/* Dark diagonal-hatch tab */}
      <div className="h-2 w-full" style={HATCH_TAB_STYLE} aria-hidden="true" />

      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-center gap-2">
          <span aria-hidden="true">✎</span>
          <span
            className="text-text-primary"
            style={{ fontSize: '14px', fontWeight: 700 }}
          >
            Design
          </span>
        </div>
        <p className="text-xs text-text-secondary">
          Iterate on a UI design with an agent — prototype + spec, folded into
          an idea on approve.
        </p>
      </div>
    </button>
  );
}
