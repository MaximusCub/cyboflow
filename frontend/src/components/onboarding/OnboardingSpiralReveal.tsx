import { useEffect, useMemo, useRef, useState } from 'react';
import {
  hiddenTileCount,
  revealFraction,
  SPIRAL_GRID,
  spiralRanks,
  REVEAL_COMPLETE_STEP,
} from '../../utils/onboardingSpiral';

/**
 * OnboardingSpiralReveal — the cream wrapper the app arrives inside.
 *
 * The tour opens fully covered: a SPIRAL_GRID² sheet of opaque cream tiles
 * over the whole viewport, with the step-0 welcome card centered on top of it.
 * Each modal-step advance peels one band of tiles away in a CLOCKWISE SPIRAL
 * starting top-left, and softens the blur over whatever is already exposed — so
 * the app sharpens into view across the modal run rather than in one beat.
 *
 * The reveal completes at REVEAL_COMPLETE_STEP, NOT at the end of the tour.
 * Steps 5–10 are coachmarks anchored to real UI (quick-session card, model
 * picker, ship chip); they cannot point into a covered or blurred app, so the
 * last tile must be gone and blur must be 0 the moment step 5 renders. Step 11's
 * card then sits over a fully sharp app. Past that the component renders null —
 * a lingering `backdrop-filter: blur(0)` layer still costs a GPU pass.
 *
 * Progress tracks the LIVE step, not maxVisitedStep: Back visibly re-wraps its
 * band, so the wrapping reads as a direct progress indicator. Skip needs no
 * handling here — the gate unmounts on a non-active status, which is exactly the
 * "snaps open" behaviour.
 *
 * Pointer-events stay off. The modal card above already owns its own full-screen
 * scrim, so input is blocked for every step this component is visible; opting in
 * here would only risk swallowing a later coachmark's click-through hole.
 */

/**
 * The wrapper's material. --paper-2 is the palette's chrome cream (rails,
 * headers, title bar), which is the closest semantic match for a sheet laid
 * OVER the app — and it stays cream under `.dark`, since the theme blocks
 * remap only the semantic --color-* tokens and never the --paper-* primitives.
 * That is deliberate: the wrapping is a physical material, not a themed
 * surface, so a dark-mode user unwraps the same cream sheet.
 *
 * Swap here to retune: --paper (#f5f1e8) is near-invisible against the card,
 * --paper-4 (#e1d8c0) is the deepest cream before it reads as tan.
 */
const WRAPPER_COLOR = 'var(--paper-2)';

/** Blur over the exposed app at step 0, eased to 0 by REVEAL_COMPLETE_STEP. */
const MAX_BLUR_PX = 18;

/**
 * Per-tile peel duration, and the gap between consecutive tiles in a band.
 *
 * STAGGER_MS is what makes the spiral legible as tiles rather than as one wave:
 * a band is ~7 tiles, so at a 26ms gap the whole band was airborne at once and
 * read as a single sheet dissolving. At 95ms the leading tile is most of the way
 * gone before the next commits, so the eye can follow the path around the ring.
 * Band duration works out ~1.2s (6 gaps + one tile's travel).
 */
const TILE_MS = 620;
const STAGGER_MS = 95;
/** Reduced-motion path: one flat cross-fade for the whole band, no stagger. */
const REDUCED_MS = 260;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

export function OnboardingSpiralReveal({ step }: { step: number }): React.JSX.Element | null {
  const reducedMotion = usePrefersReducedMotion();
  const ranks = useMemo(() => spiralRanks(SPIRAL_GRID), []);
  const hidden = hiddenTileCount(step);

  // Previous boundary, so a band's stagger is measured from where the peel
  // actually starts. Going forward the band unwinds in ascending spiral order;
  // going back it re-wraps in reverse, closing back toward the top-left.
  const prevHiddenRef = useRef(hidden);
  const prevHidden = prevHiddenRef.current;
  useEffect(() => {
    prevHiddenRef.current = hidden;
  }, [hidden]);

  if (step >= REVEAL_COMPLETE_STEP) return null;

  const blurPx = MAX_BLUR_PX * (1 - revealFraction(step));
  // Band duration drives the blur so the softening finishes with the last tile
  // of the band rather than racing ahead of it.
  const bandMs = reducedMotion
    ? REDUCED_MS
    : TILE_MS + Math.max(0, Math.abs(hidden - prevHidden) - 1) * STAGGER_MS;

  const delayFor = (rank: number): number => {
    if (reducedMotion) return 0;
    if (hidden > prevHidden && rank >= prevHidden && rank < hidden) {
      return (rank - prevHidden) * STAGGER_MS;
    }
    if (hidden < prevHidden && rank >= hidden && rank < prevHidden) {
      return (prevHidden - 1 - rank) * STAGGER_MS;
    }
    return 0;
  };

  return (
    <div className="pointer-events-none fixed inset-0" aria-hidden="true" data-testid="onboarding-spiral-reveal">
      {/* Softens the app through the gaps the peeled tiles leave behind. */}
      <div
        className="absolute inset-0"
        style={{
          backdropFilter: `blur(${blurPx}px)`,
          WebkitBackdropFilter: `blur(${blurPx}px)`,
          transition: `backdrop-filter ${bandMs}ms ease-out, -webkit-backdrop-filter ${bandMs}ms ease-out`,
        }}
      />
      <div
        className="absolute inset-0 grid"
        style={{
          gridTemplateColumns: `repeat(${SPIRAL_GRID}, 1fr)`,
          gridTemplateRows: `repeat(${SPIRAL_GRID}, 1fr)`,
        }}
      >
        {ranks.map((rank, flatIndex) => {
          const gone = rank < hidden;
          return (
            <div
              key={flatIndex}
              style={{
                background: WRAPPER_COLOR,
                opacity: gone ? 0 : 1,
                // Scaling the tile down as it goes opens a seam against its
                // neighbours — the tile reads as lifting off rather than fading.
                transform: gone && !reducedMotion ? 'scale(0.86)' : 'scale(1)',
                // Hairline guard: 1fr rounding can leave sub-pixel gaps between
                // tiles that would show blurred app through an intact wrapper.
                boxShadow: gone ? 'none' : `0 0 0 0.5px ${WRAPPER_COLOR}`,
                transition: reducedMotion
                  ? `opacity ${REDUCED_MS}ms ease-out`
                  : `opacity ${TILE_MS}ms ease-out, transform ${TILE_MS}ms cubic-bezier(.22,.61,.36,1), box-shadow ${TILE_MS}ms linear`,
                transitionDelay: `${delayFor(rank)}ms`,
                willChange: 'opacity, transform',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
