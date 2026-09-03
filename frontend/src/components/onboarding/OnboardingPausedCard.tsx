/**
 * OnboardingPausedCard — the visible "parked" state (tour status 'pending').
 * The tour parks while waiting on a real-world action, so this must NEVER
 * block the app: a small top-center notice inside OnboardingOverlay's
 * pointer-events-none tier, no scrim. The store keeps the parked step, so the
 * copy keys off it; the default covers anything outside the map.
 */
const PARK_COPY: Record<number, React.ReactNode> = {
  // Step 9's park (the last Configure pointer): waiting on the session launch.
  9: (
    <>
      Start a <b>quick session</b> and the tour picks right back up.
    </>
  ),
  // Step 10's park (the /ship click): waiting on the workflow run starting.
  10: (
    <>
      Run the <b>/ship workflow</b> and the tour picks right back up.
    </>
  ),
};
const DEFAULT_PARK_COPY: React.ReactNode = (
  <>Take the next step and the tour picks right back up.</>
);

export function OnboardingPausedCard({
  step,
  onSkip,
}: {
  step: number;
  onSkip: () => void;
}): React.JSX.Element {
  return (
    <div
      role="status"
      data-testid="onboarding-paused-card"
      className="pointer-events-auto absolute left-1/2 top-5 -translate-x-1/2 border border-[var(--paper)]/25 bg-[var(--ink)] text-[var(--paper)] shadow-[0_16px_40px_rgba(0,0,0,.45)]"
      style={{ width: 320 }}
    >
      <div className="px-[17px] pb-3.5 pt-[15px]">
        <div className="mb-1.5 text-[9px] font-bold uppercase tracking-[.16em] text-interactive">
          Tour paused
        </div>
        <div className="text-[12px] leading-[1.55] text-[var(--paper)]/85">
          {PARK_COPY[step] ?? DEFAULT_PARK_COPY}
        </div>
        <div className="mt-2.5 flex items-center justify-end">
          <button
            type="button"
            onClick={onSkip}
            className="border-none bg-transparent px-0.5 py-1 text-[9.5px] font-semibold uppercase tracking-[.1em] text-[var(--paper)]/55 transition-colors hover:text-[var(--paper)]"
          >
            Skip tour
          </button>
        </div>
      </div>
    </div>
  );
}
