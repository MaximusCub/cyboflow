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
