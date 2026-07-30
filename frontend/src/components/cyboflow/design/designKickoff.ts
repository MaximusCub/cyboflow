/**
 * DESIGN_KICKOFF_PROMPT — the canonical first-turn message for a design
 * session (design-mode.md "v0.5 — fullscreen design surface", "Auto-start +
 * clarify-first").
 *
 * Sent automatically as the first user turn of a design session (auto-start,
 * spec v0.5); it appears as a visible user bubble by design (transparency
 * over magic) — see useQuickSession's `kickoffPrompt` param, which dispatches
 * it through the same panel-input path the composer uses right after the
 * session's Claude panel is created (createQuick's `prompt` field is ignored
 * for the SDK path, so a synthetic first turn is not an option — this is a
 * real, restart-safe user turn).
 */
export const DESIGN_KICKOFF_PROMPT =
  'Begin the design session. Read the linked idea first. If it leaves meaningful design decisions open, ask me clarifying questions (one round) before designing; otherwise do your grounding pass and produce the first prototype and design-spec draft.';

/**
 * DESIGN_PROMOTE_PROMPT — the tier-promotion message for "Make it interactive"
 * (design-mode.md "In-session tier promotion").
 *
 * Sent as a real, visible user turn through the same `dispatchQuickSessionInput`
 * seam DESIGN_KICKOFF_PROMPT uses for the auto-start turn — the surface's
 * promote button dispatches it as a `continue` turn on the session's existing
 * Claude panel rather than inventing a synthetic/hidden path.
 */
export const DESIGN_PROMOTE_PROMPT =
  'Promote the prototype to the interactive tier: rebuild the CURRENT design as an interactive-prototype (inline JS allowed, still fully self-contained) and report it with that atype. Same layout, same content, every data-design-id carried over unchanged — this is a tier change, not a redesign. Iterate the interactive artifact from now on.';
