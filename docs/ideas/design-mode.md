# Idea: Design Mode — in-app iterative design sessions

**Scope hint:** large (decomposes into epics). **Status:** draft for review, not yet filed to backlog.

## Problem

The current design workflow is: design in Claude Design on the web → export a handoff packet → download → re-import into cyboflow. It fails in three ways:

1. **No repo context.** Claude Design cannot read the app's code, so designs regularly drift from the app's actual design language.
2. **Reinvention of existing surfaces** (the persistent, worst failure). When mocking a change to an existing surface (e.g. the left rail), Claude Design produces something with similar functionality and on-brand styling that is nonetheless *functionally a different design* — a parallel-universe left rail rather than our left rail plus a delta.
3. **Clunky handoff.** The download/re-import packet is manual glue that loses fidelity and adds friction.

## Goals

- A **design session**: persistent agent chat + design canvas, iterated in-app, launched from the new-session screen.
- Designs grounded in the real repo on two axes: **brand fidelity** (a runnable style kit extracted from the project) and **baseline fidelity** (design-as-diff: existing surfaces are reproduced from their implementing code, then modified).
- **Zero-export handoff:** an approved design lands as the linked idea's prototype artifact plus a design-spec section folded into the idea body; planner/sprint consume both downstream with no export/import step.
- Interaction surface deliberately scoped to **comments**, element-tagged in v1.

## Non-goals (this idea)

- **Real-app-environment tier** (rendering the project's actual components; dev-server orchestration; scratch-playground→promote). Deferred to a separate v2+ idea — it is process-supervisor scope: the app has no managed dev-server lifecycle today (`RunCommandManager.startRunCommands` is dead code; `TerminalPanelManager` teardown is a bare `pty.kill()`; the verify port pool is capture-scoped).
- **Automated screenshot grounding** as agent input (deferred; a manual side-by-side using existing verify capture is fine).
- **Design-system curation UI.** Style-kit generation happens inline in the session (agent checks, generates if missing); a dedicated curation flow is separate scope.
- **Planner design-review entry point** (follow-on; entry is the new-session screen only for now).
- **Direct user edits / arbitrary interaction surfaces** beyond comments.
- **Full-screen as a perf mechanism.** Verified unnecessary and ineffective: background canvases unmount on tab switch, the stream subscription is a singleton for the active run only, the left rail is event-driven (150ms debounce, memoized rows, no polling — git-status polling is disabled), and `display:none`/overlays don't stop JS anyway. A focus-mode *UX* may come later as its own small feature.

## UX walkthrough

1. **Entry.** The new-session screen offers **Design** alongside Workflow and Quick (the wizard's `WizardSelection` union is already 3-way; this adds a 4th arm).
2. **Setup.** Pick project → link an idea (**required**; pick an existing idea or auto-mint a stub idea inline so idealess exploration isn't blocked) → choose starting fidelity: **lo-fi concept** (static) or **hi-fi interactive** (v1). Tier can be promoted mid-session.
3. **Session.** Chat on one side; a canvas tab rendering the current prototype in the center pane. Iterate via chat turns; the agent regenerates the prototype and re-reports the artifact (same-atype re-report enriches in place).
4. **Comment mode (v1).** An explicit toggle (so tagging never interferes with prototype interactivity). Hover highlights the element under the cursor — deepest semantic element by default, with a devtools-style breadcrumb to walk up the ancestor stack (button ‹ toolbar ‹ header ‹ page). Click anchors a draft comment. Comments batch: draft → send-batch → one revision turn → addressed. The full ancestor stack is stored in the anchor regardless of the level picked.
5. **Handoff.** An **Approve design** action stores the prototype as the linked idea's artifact and folds a `## Design spec` section into the idea body (replace-not-stack semantics, same pattern as `## Architecture design`). The session can then end or continue on another iteration.

## Grounding contract (the core differentiators)

1. **Style kit — brand fidelity.** At session start the agent checks for a per-project **runnable style kit**: extracted design-token CSS (custom properties, font stack, light+dark palettes, spacing scale) plus a component sample sheet with real markup and class recipes lifted from actual components. If missing, the agent generates it as part of grounding. Prototypes inline the kit verbatim. Executable CSS, not prose — an agent copying a working stylesheet matches the app; an agent reading a markdown description drifts. Stored in the project repo at `.cyboflow/design/` (versioned with the project, user-editable), consistent with the `.cyboflow/artifacts` + `verify.json` precedents.
2. **Baseline grounding — design-as-diff (mandatory for existing surfaces).** When the design targets an existing surface, the agent MUST locate and read the components that implement it and emit a required **`### Baseline`** subsection in the design spec enumerating the files read and the behaviors reproduced, then state the delta being designed. Gate-checkable by a human (a spec for an existing surface with no Baseline section is a visible defect) and doubles as the implementation file-list for the sprint that builds it.
3. **Opportunistic DOM snapshot.** If the user happens to have the target app running, the agent may snapshot the rendered DOM of the real surface (agent-side CDP/Playwright one-liner against the user-started dev server) and use that as the baseline instance — already-compiled HTML with real class lists and real data, no JSX translation. No app-side dev-server orchestration.
4. **Honest ceiling.** The agent hand-translates JSX → static HTML: reliable for most surfaces; approximate for deeply stateful widgets (xterm, virtualized lists, drag-and-drop), where matching the look is sufficient and behavior is the deferred real-app tier's job. Source-vs-runtime divergence (feature flags, runtime-conditional UI) is exactly what the DOM-snapshot rung compensates for.

## Scope and phasing

### v0 — static tier (~1 sprint)

- Design session kind (wizard arm → quick-session plumbing, no new session-type machinery).
- Required idea link (existing or auto-minted stub).
- `design.md` first-turn prompt carrying the full grounding contract (style kit + baseline + snapshot rungs).
- Canvas = existing static `ui-prototype` artifact path unchanged (bare-sandbox iframe, injected CSP).
- Feedback = chat turns, plus the existing doc-comment machinery (highlight+comment on the folded idea-spec doc) which works today.
- Handoff = artifact + `## Design spec` body fold.

### v1 — interactive tier (~2–3 sprints)

- New **`interactive-prototype`** artifact type: JS-enabled canvas in a hardened sandbox.
- **Element-tagged comments**: comment-mode toggle, injected inspector runtime, element anchors, batch → revision turn.
- In-session tier promotion (lo-fi → hi-fi of the same design).
- Style-kit persistence/refresh polish.

### v2+ — separate ideas

Real-app tier (playground harness → promote-to-branch), design-system curation flow, planner design-review entry, automated visual style-diff judging, non-web stacks.

## Architecture design

**Session plumbing.** Add `{kind:'design'}` to `WizardSelection` (`SessionStartWizard.tsx` — already a 3-way union) with a 4th `handleStart` arm routing into the quick-session path (`createQuickSessionCore`, `sessions.is_quick=1`) — no new session-type schema. Design identity rides two things: a new **`mcpScope:'design'`** value (`ClaudeSpawnOptions` → `composeMcpServers` → `cyboflowMcpServer` env gate; precedent: `AgentThreadService`'s `'global-agent'` scope) exposing a minimal design toolset (get/update the linked idea, report/commit artifact; no sprint/board tools), and a first-turn prompt from `orchestrator/workflows/design.md`. The idea link is a real column — additive migration `sessions.design_idea_id` (plain `ALTER TABLE ADD COLUMN`, no CHECK rebuild) — because element-tagged revision targeting and per-idea artifact binding both need a durable link, and a sentinel-inferred link would rot.

**Canvas v0.** Reuse the static `ui-prototype` pipeline exactly as-is (content-blessed file write → `LiveCanvasEmbed` `sandbox=""` srcdoc + injected `ARTIFACT_PROTOTYPE_CSP`).

**Canvas v1 — `interactive-prototype` atype.** Known touch-set: migration widening the `artifacts.atype` CHECK (rebuild recipe of migration 073); `shared/types/artifacts.ts` union + `ARTIFACT_RENDER_MODE`/`COLORS`/`GLYPHS` + payload type; `cyboflowMcpServer.ts` tool enum + `validAtypes` (two literal arrays); `ArtifactTabRenderer.tsx` new case (compiler-forced by the `satisfies never` guard); a `LiveCanvasEmbed` variant with `sandbox="allow-scripts"` (**no** `allow-same-origin`) and a **new** CSP — `script-src 'unsafe-inline'` while retaining `default-src 'none'` egress blocking (the existing `ARTIFACT_PROTOTYPE_CSP` blocks scripts and cannot be reused verbatim). Audit + test `artifactFrameGuard` for JS-initiated self-navigation (`window.location`) — the `about:srcdoc` guard is atype-agnostic and should auto-cover, but script-enabled content is a new threat class; add an explicit test.

**Element tagging v1.** A small **inspector runtime injected at render time** into the prototype HTML (same injection seam as `injectPrototypeCsp` — app-owned bytes, not agent-generated) + `postMessage` bridge: parent toggles comment mode; inspector does `elementFromPoint`, draws the highlight, reports the element's ancestor stack. **Anchor contract:** the generator agent MUST stamp stable `data-design-id` attributes on semantic elements and preserve them across regenerations (prompt contract in `design.md`) — the ID is the anchor key; the stored ancestor stack is the relocation fallback and the human/agent-readable context. Persistence rides the existing feedback tables: widen the `feedback_comments.atype` CHECK (currently `idea-spec`/`arch-design` only) and add an element-anchor variant in `anchor_json` (+ `FeedbackAtype` guards).

**Comment-batch delivery — no revisionWorker generalization needed.** The detached `revisionWorker` exists because planner runs are *parked* at gates with a busy orchestrator. A design session's driving agent is idle between turns, so a sent comment batch is simply delivered as the **next agent turn** (existing `queueInput` next-turn seam) carrying a structured comment payload; the driving agent revises the prototype and re-reports the artifact. The feedback lifecycle (draft→sent→addressed, batch rounds) is reused; the delivery mechanism is the chat seam, not a detached worker. The `revisionWorker` file-target generalization is only needed later for the planner design-review entry (parked-gate context) and stays out of v1.

**Handoff.** `cyboflow_report_artifact` (`ui-prototype` v0 / `interactive-prototype` v1) + `cyboflow_update_task` folding `## Design spec` into `ideas.body` with the same paired-fence replace-not-stack grammar as `## Architecture design` (`makeFenceState` family). Binding the prototype artifact per-entity (so planner gates can surface it beside the idea) follows the `(runId, atype, sourceRef)` pattern established for `idea-spec`/`arch-design`.

## Acceptance criteria

**v0**

- New-session screen offers Design; starting one creates a worktree-backed quick-session variant with `design_idea_id` set (picker or auto-minted stub).
- Session agent produces a static prototype that inlines the project style kit; for an existing-surface design the folded spec contains a `### Baseline` section enumerating the implementing files; a missing Baseline section on an existing-surface design is gate-visible.
- Chat iteration regenerates the prototype in place; Approve stores the artifact and folds `## Design spec` into the linked idea's body; a subsequent planner/sprint run can consume both without any export step.
- `pnpm test:unit` green; the `__quick__` two-way seams (`transitions.ts`, `variantResolver.ts`, `experimentStore.ts`, `interactiveClaudeManager.ts`) behave correctly for design sessions (rotation skipped, revival policy unchanged).

**v1**

- Interactive prototype executes JS inside the canvas with **no network egress** (CSP test) and no frame escape (JS self-navigation test on `artifactFrameGuard`).
- Comment mode: toggle on/off; hover highlights with ancestor-stack walk; anchored comments persist; batch-send delivers one revision turn that addresses the comments; anchors survive prototype regeneration via `data-design-id`.
- Tier promotion converts a lo-fi session to hi-fi without losing the idea link or comment history.

## Risks and landmines

- **Migration contention:** next free migration is 078; unpushed sibling branches are minting 075–077 (rail-dismiss, daily-recap) — whichever lands last renumbers. The artifacts-CHECK test DBs must seed any new atype.
- **Security:** the v1 canvas executes agent-generated JS in a renderer iframe. Containment = minimal sandbox (`allow-scripts` only), egress-blocking CSP, existing frame-navigation guard — each needs an explicit test, and the CSP/sandbox pair should be reviewed as a unit before ship.
- **Quick-session policy inheritance:** design sessions ride `is_quick=1`, so they inherit quick-session behaviors — notably boot-resume excludes `__quick__` from `--resume` revival, meaning a design session does not auto-resume after app restart. Acceptable for v0 (same as quick sessions today); revisit if design sessions become long-lived.
- **Anchor rot:** without `data-design-id` discipline the element anchors orphan on every regeneration; the prompt contract plus ancestor-stack relocation is the mitigation, and the write-tests lane should cover relocation.
- **Style-kit staleness:** a committed kit can drift from the app; the session-start check should compare kit mtime/hash against the token source files and offer a refresh.

## Open questions

- Approve action placement: canvas-header button vs chat command (leaning canvas button with a confirm).
- One prototype per session (aligned with one-artifact-per-atype-per-run) vs multiple named prototypes — v0 assumes one, iterated in place.
- Stub-idea auto-mint defaults: which stage/priority does the stub land in, and should it be flagged as design-originated for later planner pickup?
