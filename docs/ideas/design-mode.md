# Idea: Design Mode — in-app iterative design sessions

**Scope hint:** large (decomposes into epics). **Status:** draft rev 2 (Codex adversarial round 1: 8 findings, all folded in), not yet filed to backlog.

## Problem

The current design workflow is: design in Claude Design on the web → export a handoff packet → download → re-import into cyboflow. It fails in three ways:

1. **No repo context.** Claude Design cannot read the app's code, so designs regularly drift from the app's actual design language.
2. **Reinvention of existing surfaces** (the persistent, worst failure). When mocking a change to an existing surface (e.g. the left rail), Claude Design produces something with similar functionality and on-brand styling that is nonetheless *functionally a different design* — a parallel-universe left rail rather than our left rail plus a delta.
3. **Clunky handoff.** The download/re-import packet is manual glue that loses fidelity and adds friction.

## Goals

- A **design session**: persistent agent chat + design canvas, iterated in-app, launched from the new-session screen.
- Designs grounded in the real repo on two axes: **brand fidelity** (a runnable style kit extracted from the project) and **baseline fidelity** (design-as-diff: existing surfaces are reproduced from their implementing code, then modified).
- **Zero-export handoff:** an approved design lands as an idea-bound prototype artifact plus a design-spec section folded into the idea body; planner/sprint runs can *discover and read both* downstream with no export/import step.
- Interaction surface deliberately scoped to **comments**, element-tagged in v1.

## Non-goals (this idea)

- **Real-app-environment tier** (rendering the project's actual components; dev-server orchestration; scratch-playground→promote). Deferred to a separate v2+ idea — it is process-supervisor scope: the app has no managed dev-server lifecycle today (`RunCommandManager.startRunCommands` is dead code; `TerminalPanelManager` teardown is a bare `pty.kill()`; the verify port pool is capture-scoped).
- **Non-Claude / non-SDK design sessions.** Design sessions are pinned to the Claude SDK substrate in v0/v1 (see Architecture — this is a security boundary, not a preference). Interactive-PTY or Codex-driven design sessions would require a cross-substrate MCP scope contract that does not exist; deferred until one does.
- **Automated screenshot grounding** as agent input (deferred; a manual side-by-side using existing verify capture is fine).
- **Design-system curation UI.** Style-kit generation happens inline in the session (agent checks, generates if missing); a dedicated curation flow is separate scope.
- **Planner design-review entry point** (follow-on; entry is the new-session screen only for now).
- **Direct user edits / arbitrary interaction surfaces** beyond comments.
- **Full-screen as a perf mechanism.** Verified unnecessary and ineffective: background canvases unmount on tab switch, the stream subscription is a singleton for the active run only, the left rail is event-driven (150ms debounce, memoized rows, no polling — git-status polling is disabled), and `display:none`/overlays don't stop JS anyway. A focus-mode *UX* may come later as its own small feature.

## UX walkthrough

1. **Entry.** The new-session screen offers **Design** alongside Workflow and Quick (the wizard's `WizardSelection` union is already 3-way; this adds a 4th arm).
2. **Setup.** Pick project → link an idea (**required**; pick an existing idea or auto-mint a stub idea inline so idealess exploration isn't blocked) → choose starting fidelity: **lo-fi concept** (static) or **hi-fi interactive** (v1). Tier can be promoted mid-session.
3. **Session.** Chat on one side; a canvas tab rendering the current prototype in the center pane. Iterate via chat turns; the agent regenerates the prototype and re-reports the artifact (same-atype re-report enriches in place).
4. **Comment mode (v1).** An explicit toggle. Entering comment mode **freezes the prototype**: the canvas re-renders the same HTML with the prototype's own scripts stripped and the app-owned inspector as the *only* script in the frame (interactivity is paused in comment mode by design, so this costs nothing). Hover highlights the element under the cursor — deepest semantic element by default, with a devtools-style breadcrumb to walk up the ancestor stack (button ‹ toolbar ‹ header ‹ page). Click anchors a draft comment. Comments batch: draft → send-batch → one revision turn → addressed. The full ancestor stack is stored in the anchor regardless of the level picked.
5. **Handoff.** An **Approve design** action — a single host-owned command, not agent tool choreography — snapshots the prototype bound to the linked idea and folds a `## Design spec` section into the idea body (replace-not-stack). The session can then end or continue iterating (a re-approve replaces the bound design).

## Grounding contract (the core differentiators)

1. **Style kit — brand fidelity.** At session start the agent checks for a per-project **runnable style kit**: extracted design-token CSS (custom properties, font stack, light+dark palettes, spacing scale) plus a component sample sheet with real markup and class recipes lifted from actual components. If missing, the agent generates it as part of grounding. Prototypes inline the kit verbatim. Executable CSS, not prose — an agent copying a working stylesheet matches the app; an agent reading a markdown description drifts. Stored in the project repo at `.cyboflow/design/` (versioned with the project, user-editable), consistent with the `.cyboflow/artifacts` + `verify.json` precedents.
2. **Baseline grounding — design-as-diff (mandatory for existing surfaces).** When the design targets an existing surface, the agent MUST locate and read the components that implement it and emit a required **`### Baseline`** subsection in the design spec enumerating the files read and the behaviors reproduced, then state the delta being designed. Gate-checkable by a human (a spec for an existing surface with no Baseline section is a visible defect) and doubles as the implementation file-list for the sprint that builds it.
3. **Opportunistic DOM snapshot.** If the user happens to have the target app running, the agent may snapshot the rendered DOM of the real surface (agent-side CDP/Playwright one-liner against the user-started dev server) and use that as the baseline instance — already-compiled HTML with real class lists and real data, no JSX translation. No app-side dev-server orchestration.
4. **Honest ceiling.** The agent hand-translates JSX → static HTML: reliable for most surfaces; approximate for deeply stateful widgets (xterm, virtualized lists, drag-and-drop), where matching the look is sufficient and behavior is the deferred real-app tier's job. Source-vs-runtime divergence (feature flags, runtime-conditional UI) is exactly what the DOM-snapshot rung compensates for.

## Scope and phasing

### v0 — static tier (~1 sprint, top of the estimate)

- Design session kind (wizard arm → quick-session plumbing, SDK-substrate-pinned).
- Required idea link with integrity contract (existing idea or auto-minted stub; see Architecture).
- `design.md` first-turn prompt carrying the full grounding contract (style kit + baseline + snapshot rungs).
- Canvas = existing static `ui-prototype` artifact path unchanged (bare-sandbox iframe, injected CSP).
- **In-session feedback = chat turns only.** (The folded idea body still gets the full existing doc-comment/highlight machinery *at the next planner gate* — that path already works today and needs nothing from v0. In-session doc comments are NOT claimed: the existing send path requires a parked run with a pending blocking gate, which a design session never satisfies.)
- Handoff = the host-owned **Approve** command: idea-bound prototype snapshot + `## Design spec` body fold + the read path that makes both discoverable by later planner/sprint runs.

### v1 — interactive tier (~2–3 sprints)

- New **`interactive-prototype`** artifact type: JS-enabled canvas in a hardened sandbox, introduced together with a **canonical artifact-policy registry** (see Architecture) so loader/blessing/snapshot guards can't silently miss the new type.
- **Element-tagged comments**: comment-mode freeze + inspector, element anchors, a new design-feedback send path (both feedback tables widened), batch → revision turn.
- In-session tier promotion (lo-fi → hi-fi of the same design).
- Style-kit persistence/refresh polish.

### v2+ — separate ideas

Real-app tier (playground harness → promote-to-branch), design-system curation flow, planner design-review entry, automated visual style-diff judging, non-web stacks, non-SDK substrate support.

## Architecture design

**Session plumbing — SDK-pinned, fail-closed.** Add `{kind:'design'}` to `WizardSelection` (`SessionStartWizard.tsx` — already a 3-way union) with a 4th `handleStart` arm routing into the quick-session path (`createQuickSessionCore`, `sessions.is_quick=1`) — no new session-type schema. **Design sessions resolve to the Claude SDK substrate unconditionally** — never interactive-PTY, never Codex — because the MCP scope mechanism (`mcpScope` on `ClaudeSpawnOptions` → `composeMcpServers` → `cyboflowMcpServer` env gate) exists only on the SDK path; `InteractiveClaudeManager` and Codex runtimes have no scope contract, and a design session spawned there would silently receive the full run-scoped toolset. If the SDK substrate or a Claude target is unavailable, session creation **fails with a clear error** (fail-closed) rather than falling back. The new `mcpScope:'design'` value exposes a minimal toolset (get/update the linked idea, report artifact; no sprint/board/backlog-wide tools), and scope enforcement is tested by **direct tool invocation being rejected** for out-of-scope tools — not merely their omission from ListTools. First-turn prompt from `orchestrator/workflows/design.md`.

**Idea link — integrity contract.** Additive migration `sessions.design_idea_id` (plain `ALTER TABLE ADD COLUMN`; SQLite FK enforcement is not retrofitted — integrity is enforced at the write chokepoints): (a) creation validates the idea exists, belongs to the session's project, and is not decomposed; (b) **every** design-scoped MCP operation re-validates project ownership and target liveness (cross-project ids rejected); (c) if the idea is deleted or decomposed mid-session, design-scoped writes fail soft with a user-visible "link broken — relink or end session" state (parity with the existing decomposed-idea influence guard); (d) stub minting is ordered *after* worktree+session creation succeeds and links in the same write; a launch failure after mint compensates by archiving the stub (a stranded stub is flagged, never silently kept). Tests cover launch failure, concurrent idea deletion, cross-project ids, and create retries.

**Canvas v0.** Reuse the static `ui-prototype` pipeline exactly as-is (content-blessed file write → `LiveCanvasEmbed` `sandbox=""` srcdoc + injected `ARTIFACT_PROTOTYPE_CSP`).

**Canvas v1 — `interactive-prototype` atype + artifact-policy registry.** The new atype is introduced by way of a **canonical per-atype policy registry** (single source of truth consumed by report validation, payload blessing, IPC HTML loading, CSP selection, byte requirements, snapshot lookup, and rendering) — generalizing the lesson that made `VALID_ATYPES` derived. This is required, not optional: today `LoadArtifactHtmlAtype`/`coerceAtype` accept only `ui-prototype`/`generic`, blessing is per-atype, and `requiredBytePaths` treats unknown atypes as byte-free — added naively, an interactive artifact could bypass canonical-file validation, fail to load, or "successfully" commit with zero HTML bytes and then lose the only copy when the DB row is deleted. A **report→commit→row-delete→reload durability test** proves the HTML survives with the interactive CSP intact. Remaining touch-set as previously mapped: migration widening the `artifacts.atype` CHECK (rebuild recipe of migration 073); `shared/types/artifacts.ts` union + render-mode/color/glyph maps + payload type; MCP tool enum + `validAtypes`; `ArtifactTabRenderer` case (compiler-forced); `LiveCanvasEmbed` variant with `sandbox="allow-scripts"` (**no** `allow-same-origin`) and a new CSP — `script-src 'unsafe-inline'` with `default-src 'none'` egress blocking retained.

**Frame navigation — no external open for scripted frames.** The existing `artifactFrameGuard` blocks `about:srcdoc` navigation but then offers `https?://` targets to `shell.openExternal` — for a script-enabled frame that behavior converts `window.location = 'https://…'` into OS-browser egress (URL-encoded exfiltration, browser spam) even though the frame stays confined. Script-enabled artifact frames therefore get their own guard class: **all programmatic navigation is blocked outright with no external open**. External links inside a prototype surface only through a trusted parent-side affordance (the parent renders the link chrome; opening requires a real user gesture on app-owned UI). Tests assert `shell.openExternal` is never invoked for scripted-frame navigation attempts.

**Element tagging v1 — single-writer inspector channel.** The inspector cannot authenticate itself to the parent from inside the frame: with `allow-same-origin` absent the origin is opaque (`MessageEvent.origin` unusable), `event.source` only proves the frame, and any nonce injected into the realm is readable by prototype code. The design removes the ambiguity instead of trying to authenticate through it: **entering comment mode re-renders the srcdoc with all prototype `<script>` content stripped at the injection seam (app-owned bytes) and the app's inspector injected as the sole script** — the channel has exactly one possible writer. Defense in depth on the parent side regardless: strict message schema validation, payload size caps, and rate limiting; inspector output is treated as UI input (element stack for anchoring), never as a security decision. Anchor contract unchanged: generator stamps stable `data-design-id` attributes (prompt contract in `design.md`); the ID is the anchor key; the stored ancestor stack is the relocation fallback and human/agent-readable context.

**Design feedback path v1 — new send path, both tables widened.** The existing feedback send path cannot be reused: `sendFeedbackHandler`'s guard chain requires a parked run with a pending blocking decision gate, and migration 077 CHECK-constrains `atype` on **both** `feedback_comments` and `feedback_batches` to `idea-spec`/`arch-design`. v1 adds: (a) a migration widening **both** tables' CHECKs (+ `FeedbackAtype` guards) with the element-anchor variant in `anchor_json`; (b) a **design-feedback send path** with its own guard chain (session alive, idea link valid, prototype artifact present — no parked-gate requirement); (c) delivery as the design session's next driving-agent turn via the **SDK quick-session input seam** (the substrate is pinned, so exactly one delivery path needs to exist — `runs.queueInput` is a flow-run seam and is *not* claimed), with durable batch states (pending → delivering → applied/failed), ordering, retry, and restart recovery (boot sweep reverts undelivered batches to drafts, matching the existing feedback boot-sweep pattern). The detached `revisionWorker` generalization stays out of scope until the planner design-review entry (parked-gate context) exists.

**Approve — host-owned, idempotent.** Approve is a single main-process command, not agent choreography of `report_artifact` + `update_task`: it takes the session id + an **expected idea version**, then (1) validates the idea link, (2) snapshots the current prototype bound to the idea, (3) replaces the `## Design spec` section via an **app-owned replacement function** (extending the paired-fence grammar machinery beyond its current hard-coded arch-design target), and (4) records a durable handoff row with an idempotency key so a crash between steps is recoverable (re-running Approve converges; a snapshot without its body fold or vice versa is repaired, never left silent). A stale expected version rejects with a re-read prompt rather than overwriting concurrent idea edits.

**Idea-bound artifact + read path (v0 — this is the zero-export promise).** Artifacts today are keyed and read by `(runId, atype)`; nothing lets a later run find a prototype by idea, and `cyboflow_report_artifact` accepts no `source_ref`. v0 therefore adds: the report handler stamps `source_ref` **server-side** from the session's validated `design_idea_id` (never agent-supplied); an **approved-design read model** (idea → current approved prototype, replace-on-re-approve semantics, superseded snapshots retained); and consumption wiring — planner/sprint gate surfaces show the bound prototype beside the idea, and the flows' prompts/tools can resolve it (e.g. surfaced via `cyboflow_get_task` for the linked idea). Without this the artifact half of the handoff is undiscoverable and only the body fold survives.

## Acceptance criteria

**v0**

- New-session screen offers Design; starting one creates a worktree-backed, **SDK-substrate** quick-session variant with a validated `design_idea_id` (picker or auto-minted stub); creation fails closed with a clear error when the SDK substrate/Claude target is unavailable.
- Out-of-scope MCP tools are **rejected on direct invocation** from a design session (tested), not merely unlisted.
- Session agent produces a static prototype that inlines the project style kit; for an existing-surface design the folded spec contains a `### Baseline` section enumerating the implementing files; a missing Baseline section on an existing-surface design is gate-visible.
- The host-owned Approve command is idempotent under crash/retry (tested at each step boundary), rejects stale idea versions, binds the prototype to the idea server-side, and folds `## Design spec` replace-not-stack.
- A subsequent planner/sprint run can **discover and read** both the folded spec and the bound prototype with no export step (read-model + gate-surface test).
- Idea-link integrity: cross-project ids rejected; deletion/decomposition mid-session fails soft into the relink state; stub-mint launch failure leaves no silently-stranded stub.
- `pnpm test:unit` green; the `__quick__` two-way seams (`transitions.ts`, `variantResolver.ts`, `experimentStore.ts`, `interactiveClaudeManager.ts`) behave correctly for design sessions (rotation skipped, revival policy unchanged).

**v1**

- Interactive prototype executes JS inside the canvas with **no network egress** (CSP test) and **no navigation escape**: programmatic navigation is blocked without external open, and `shell.openExternal` is asserted uncalled for scripted-frame navigation.
- Artifact-policy registry: the interactive atype round-trips report → commit → DB-row delete → reload with HTML bytes intact and the interactive CSP applied (durability test); an atype missing from the registry fails loudly at report time.
- Comment mode: entering it strips prototype scripts and injects the inspector as the sole script (single-writer channel test); parent validates message schema/size/rate; hover + ancestor-stack walk + anchored comments work; batch-send delivers one revision turn via the SDK quick-session seam with durable batch states surviving app restart; anchors survive prototype regeneration via `data-design-id`.
- Both feedback tables accept the new atype; the design-feedback guard chain enforces session-alive + valid link + prototype-present.
- Tier promotion converts a lo-fi session to hi-fi without losing the idea link or comment history.

## Risks and landmines

- **Migration contention:** next free migration is 078; unpushed sibling branches are minting 075–077 (rail-dismiss, daily-recap) — whichever lands last renumbers. The artifacts-CHECK test DBs must seed any new atype.
- **Security:** the v1 canvas executes agent-generated JS in a renderer iframe. Containment = minimal sandbox (`allow-scripts` only), egress-blocking CSP, the scripted-frame navigation block (no external open), and the single-writer inspector channel — each with an explicit test, and the sandbox/CSP/guard triple reviewed as a unit before ship.
- **Substrate pin as product constraint:** design sessions are Claude-SDK-only; users who prefer interactive/Codex sessions don't get design mode until a cross-substrate scope contract exists. Deliberate trade (security boundary first).
- **Quick-session policy inheritance:** design sessions ride `is_quick=1`, so they inherit quick-session behaviors — notably boot-resume excludes `__quick__` from `--resume` revival, meaning a design session does not auto-resume after app restart. Acceptable for v0 (same as quick sessions today; the durable feedback-batch sweep covers the v1 in-flight case); revisit if design sessions become long-lived.
- **Anchor rot:** without `data-design-id` discipline the element anchors orphan on every regeneration; the prompt contract plus ancestor-stack relocation is the mitigation, and the write-tests lane should cover relocation.
- **Style-kit staleness:** a committed kit can drift from the app; the session-start check should compare kit mtime/hash against the token source files and offer a refresh.

## Open questions

- Approve action placement: canvas-header button vs chat command (leaning canvas button with a confirm).
- One prototype per session (aligned with one-artifact-per-atype-per-run) vs multiple named prototypes — v0 assumes one, iterated in place.
- Stub-idea auto-mint defaults: which stage/priority does the stub land in, and should it be flagged as design-originated for later planner pickup?
- Whether the approved-design read model lives on the artifacts table (`source_ref` + status column) or a small dedicated table — decide at implementation with the registry design.
