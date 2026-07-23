# Implementation plan: idle-gated quick-session summaries (rolling summary + append-only history)

Status: PROPOSAL — under adversarial review, not yet implemented.
Scope: quick sessions only (v1). Author session: curious-stream-20260723, 2026-07-23.

## 1. Problem and UX

Reopening a quick session after time away means re-deriving what the session was
about from the raw transcript. Fix: the quick-session canvas
(`frontend/src/components/cyboflow/QuickSessionCanvas.tsx`) grows two pieces of
derived text, updated by a cheap Haiku call:

- **Rolling summary** — 1–2 sentences, always current, rendered inside the
  existing 300px SESSION node below the cost row.
- **Append-only history** — one past-tense sentence per *sitting* (a burst of
  activity ending in an idle lull), rendered as an expandable card below the
  SESSION node.

A **sitting** is defined by the trigger: a 5-minute lull after the last
completed turn. Each sitting produces at most one Haiku call, which returns
both outputs at once.

## 2. Design invariants (the gating stack)

The over-call protection is layered; the content watermark — not the timer —
is the load-bearing gate:

1. **Edge-triggered arm.** A per-session `setTimeout` (5 min,
   `SESSION_SUMMARY_IDLE_MS = 5 * 60_000`) is armed only by a turn-end event.
   Never scan-on-boot, never poll. Substrate seams (both carry `sessionId`):
   - SDK: `claudeCodeManager` per-logical-turn `'exit'` emission inside
     `finishTurn()` (`main/src/services/panels/claude/claudeCodeManager.ts:2165`).
   - PTY: the Stop-hook chain's `'turn-end'` re-emitted on
     `SubstrateDispatchFacade` (`main/src/services/substrateDispatchFacade.ts:226-238`).
2. **Debounce reset.** The next turn-start clears the pending timer — SDK
   `'spawned'` (`emitTurnStart`, `claudeCodeManager.ts:1545-1563`); for PTY,
   arm/clear both key off the facade events available at the `main/src/index.ts`
   wiring seam. Note: on the SDK substrate `'exit'` means "turn ended", NOT
   "went idle" — the debounce is the idle discriminator.
3. **Content watermark.** `session_summaries.last_turn_id` stores the highest
   `conversation_messages.id` already summarized. At fire time read
   `WHERE session_id = ? AND id > ? ORDER BY id ASC` (the
   `getSessionTokenUsage` lastId pattern, `main/src/database/database.ts:3632-3664`
   — AUTOINCREMENT `id`, never `timestamp`, is the monotonic key). Empty
   delta → silent no-op, watermark unchanged. This makes boot restores,
   re-derived idles, and timer refires structurally free.
4. **Materiality floor.** The delta must contain ≥1 `assistant` message
   (skips abandoned user-only prompts). Immaterial → no-op, watermark unchanged.
5. **Serialization.** In-memory `inFlight: Set<sessionId>` + a global
   concurrency cap of 1 (simple promise-chain queue). Refires during an
   in-flight call no-op.
6. **Race guard.** `sessions.updated_at` is the activity clock (bumped only by
   the same spawn/exit writes; presentation writes must not bump it — see
   `main/src/database/database.ts:3055-3056` and
   `main/src/database/__tests__/sessionUpdatedAtSemantics.test.ts`). At fire
   time, if `updated_at` moved after the arm timestamp, re-arm instead of firing.
7. **Failure policy.** On error/timeout: watermark unchanged, no hot retry —
   the next idle edge (or lazy catch-up) retries naturally. Per-session
   in-memory `consecutiveFailures`; ≥3 → suspended until app restart.
8. **Lazy catch-up.** The `sessions:get-summary` IPC read, when it observes
   `MAX(conversation_messages.id) > last_turn_id` and the session is not
   currently running a turn, kicks a fire-and-forget summarize that bypasses
   the 5-min timer but respects every other gate. This plugs the
   "quit the app within 5 minutes of the last turn" hole: the summary
   refreshes the moment the session is next looked at.
9. **Eligibility gates** (checked at fire time, so toggling settings takes
   effect on pending timers): env kill switch `CYBOFLOW_DISABLE_SESSION_SUMMARY=1`
   (mirror of `CYBOFLOW_DISABLE_WARM_SDK`); config toggle
   `sessionSummaryEnabled` (§6); session exists, not archived, and is a quick
   session per the sentinel predicate `chat_run_id IS NOT NULL`
   (`main/src/orchestrator/quickSessionListing.ts:40-51` — NOT the dead
   `is_quick` column, which has been `0` for every session since migration 012).

Rejected alternatives (for the record): summarize-per-turn (calls scale with
turns; history becomes per-turn noise); periodic all-session scan (the retired
`IdleSessionDetector` shape — boot storms; see
`main/src/orchestrator/Orchestrator.ts:67-78`); lazy-only (stale flash on open;
collapses multiple sittings into one history sentence).

## 3. The model call

One call produces both outputs. New file
`main/src/orchestrator/sessionSummary/sessionSummaryQuery.ts`, cloning the
one-shot `loadSdkQuery()` pattern of `main/src/orchestrator/eval/evalJudgeQuery.ts`
/ `main/src/orchestrator/programmatic/monitorQuery.ts`:

- `loadSdkQuery()` from `main/src/utils/lazyAgentSdk.ts`; single string prompt;
  **no tools, no cwd**; `maxTurns: 1`;
  `pathToClaudeCodeExecutable: resolveClaudeExecutablePath()`.
- `model: 'haiku'` — resolves to `claude-haiku-4-5` via the existing
  `MODEL_ALIAS_TO_ID` (`main/src/services/panels/claude/modelContext.ts:46-53`).
  No new alias plumbing.
- Hard deadline 60s via the `makeDeadline()` AbortController pattern
  (`evalJudgeQuery.ts:78-103`). Single attempt per fire.
- Input: previous rolling summary + the delta transcript formatted as
  `USER:` / `ASSISTANT:` blocks, clipped by a pure `clipDeltaForPrompt()`:
  cap ~48,000 chars total; user messages kept (each capped 2,000 chars);
  assistant messages head 1,500 + tail 500 chars; when still over, drop oldest
  assistant bodies first, keeping the final assistant message.
- Output contract: a single JSON object
  `{"summary": "<1-2 sentences, present-tense state of the session>",
    "history_sentence": "<one past-tense sentence for this sitting>"}`.
  Parse: strip optional code fences → `JSON.parse` → validate both fields are
  non-empty strings. Malformed → treated as a failure (no watermark advance).
- **Cost surfacing** (closes an existing observability gap — none of the
  one-shot query paths record cost today): read `total_cost_usd` from the SDK
  `result` message and accumulate into `session_summaries.cost_usd_total`,
  increment `calls_count`.

Explicit non-choices: do NOT route through `AgentThreadService` /
`ClaudeCodeManager.spawnCliProcess` (that is a real session turn on the warm
machinery and would bump the activity clock); do NOT use raw
`@anthropic-ai/sdk` (declared but unused in `main/src`; new auth path).
The summarizer never touches the session's warm SDK process.

Implementer verification step: confirm the shape of
`conversation_messages.content` for `assistant` rows (plain text vs
JSON-encoded) at the write sites (`main/src/services/sessionManager.ts:609-928`)
and normalize in the transcript formatter accordingly.

## 4. Persistence (migration 081)

Separate tables, not `sessions` columns — summary writes must never bump
`sessions.updated_at` (activity clock), and cascade-delete stays clean.
`081` is the next free number on this branch (`080_agent_thread_last_turn.sql`
is the current ceiling); renumber-on-land applies if another branch lands first.

`main/src/database/migrations/081_session_summaries.sql`:

```sql
CREATE TABLE IF NOT EXISTS session_summaries (
  session_id     TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  summary        TEXT NOT NULL DEFAULT '',
  last_turn_id   INTEGER NOT NULL DEFAULT 0,
  calls_count    INTEGER NOT NULL DEFAULT 0,
  cost_usd_total REAL NOT NULL DEFAULT 0,
  updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS session_summary_entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  entry      TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_session_summary_entries_session
  ON session_summary_entries(session_id, id);

-- conversation_messages currently has only single-column indexes
-- (schema.sql:40-41); the watermark read needs (session_id, id).
CREATE INDEX IF NOT EXISTS idx_conversation_messages_session_id_id
  ON conversation_messages(session_id, id);
```

New `main/src/database/database.ts` methods (+ row types in
`main/src/database/models.ts`):
`getSessionSummary(sessionId)`, `upsertSessionSummary({sessionId, summary,
lastTurnId, costUsdDelta})` (single UPSERT that also bumps `calls_count`/
`cost_usd_total`/`updated_at`), `appendSessionSummaryEntry(sessionId, entry)`,
`listSessionSummaryEntries(sessionId)`,
`getConversationMessagesAfter(sessionId, afterId)`.

Implementer verification step: confirm whether `PRAGMA foreign_keys` is ON at
runtime for the app DB. If not, `ON DELETE CASCADE` is inert — add explicit
`DELETE FROM session_summaries / session_summary_entries` to the session
delete path instead. (Migration-file rule regardless: FK pragma toggles stay
outside the per-file transaction, `docs/CODE-PATTERNS.md`.)

## 5. Scheduler

New file `main/src/orchestrator/sessionSummary/sessionSummaryScheduler.ts` —
**pure module with injected deps** (db handle, `isEnabled()` closure, summarize
function, clock), respecting the orchestrator layering rule (no `services/*`
imports — same discipline as `quickSessionListing.ts:13-16`). Shape imitates
`main/src/orchestrator/terminalEvalSubscriber.ts` (event-driven, idempotence
via DB check, fire-and-forget) plus a `Map<string, NodeJS.Timeout>` debounce
registry (the warm-idle-timer / `gitStatusManager.ts:43` shape).

Public surface:
- `noteTurnEnd(sessionId)` — arm/re-arm the 5-min timer; record arm timestamp.
- `noteTurnStart(sessionId)` — clear pending timer.
- `maybeSummarizeNow(sessionId, reason: 'idle' | 'lazy-catchup')` — run the
  gate stack (§2) and, if it survives, the call + persist. Reasons only affect
  logging.
- `dispose()` — clear all timers (app shutdown).

Wiring in `main/src/index.ts` (where cross-layer glue already lives, e.g. the
`onInteractiveTurnEnd` callback threading at `index.ts:1860-1871` and the
`terminalEvalSubscriber` hookup at `index.ts:1761-1785`):
- `claudeCodeManager.on('exit', ({sessionId}) => scheduler.noteTurnEnd(sessionId))`
- `claudeCodeManager.on('spawned', ({sessionId}) => scheduler.noteTurnStart(sessionId))`
- facade `'turn-end'` → `noteTurnEnd`; the PTY turn-start equivalent at the same
  seam → `noteTurnStart`.

No file under `main/src/services/panels/claude/` is modified (external
subscription only), so the Tier-3 `pnpm test:integration` gate is not mandated
by the AC rule — `pnpm test:unit` is the gate.

Persist step on success (single transaction): `upsertSessionSummary` with
`lastTurnId = max(id) of the delta actually sent` + `appendSessionSummaryEntry`.

## 6. Settings toggle (Assistant tab)

Config plumbing mirrors `assistantEnabled` end-to-end (absent ⇒ **enabled**;
the toggle is the kill switch, checked at fire time):

1. `main/src/types/config.ts` — `sessionSummaryEnabled?: boolean` on
   `AppConfig` (near the assistant block, ~line 48-75) AND on
   `UpdateConfigRequest` (~line 207-216), with the standard mirrored comments.
2. `main/src/services/configManager.ts` — getter next to
   `isAssistantEnabled()` (~line 280):
   `isSessionSummaryEnabled(): boolean { return this.config.sessionSummaryEnabled !== false; }`
   — NOT seeded into constructor defaults (same convention as the other
   assistant globals, so existing users default on).
3. `frontend/src/components/Settings.tsx` — Assistant tab
   (`activeTab === 'assistant'`, line 1055): new `SettingsSection` titled
   "Session summaries" inside the existing `CollapsibleCard` (after the
   Context Retention section, ~line 1154+):
   - `Switch id="session-summary-enabled" label="Summarize idle sessions"`,
     state `sessionSummaryEnabled` (default `true`), loaded via
     `data.sessionSummaryEnabled !== false` in the config-load effect
     (~line 184-188) and included in the save payload (~line 247-259).
   - Helper copy: "After a quick session sits idle for 5 minutes, a small
     Haiku call updates its summary and history on the session canvas.
     Fractions of a cent per sitting; off means no calls and the canvas
     hides the summary."
   - This section is NOT wrapped in the `!assistantEnabled` disable-overlay —
     it is independent of the assistant rail; it merely lives on this tab.
4. Server-side enforcement: the scheduler and the lazy catch-up both consult
   `configManager.isSessionSummaryEnabled()`; the `sessions:get-summary`
   response carries `enabled` so the frontend hides the UI without a separate
   config fetch.

Related cleanup (separate chore commit, optional): the dead
`IdleSessionReviewConfig` (`main/src/types/config.ts:13-34`,
`configManager.getIdleSessionReviewConfig()` with zero callers) and the stale
Settings copy describing the retired idle-session review mint
(`Settings.tsx:1030-1044`) — either delete or fold into the new setting.
Not required for this feature.

## 7. IPC + frontend

- Payload type promoted to shared per the IPC parity rules:
  `shared/types/sessionSummary.ts` —
  `interface SessionSummaryPayload { enabled: boolean; summary: string | null;
   updatedAt: string | null; entries: Array<{ id: number; entry: string;
   createdAt: string }>; }` — imported by BOTH `main/src/ipc/session.ts` and
  the frontend (never a local mirror; `IPCResponse<SessionSummaryPayload>`
  with explicit `T`).
- `main/src/ipc/session.ts`: `ipcMain.handle('sessions:get-summary', ...)` —
  reads summary + entries, and performs the lazy catch-up kick (§2.8).
- `main/src/preload.ts` (~line 234-236 block): `getSummary(sessionId)` binding.
- `frontend/src/utils/api.ts` (~line 116-128 block): typed wrapper.
- `frontend/src/hooks/useSessionSummary.ts`: fetch on mount + 30s poll while
  visible, paused on `document.hidden` — mirror of
  `frontend/src/hooks/useSessionMetrics.ts:207-235`'s visibility handling.
  (The data only changes when the session idles; 30s is plenty.)
- `frontend/src/components/cyboflow/QuickSessionCanvas.tsx`:
  - Summary block inside the SESSION node (`data-testid="quick-session-node"`,
    lines 557-719), inserted after the cost row (~line 717): top-border
    divider + `SUMMARY` eyebrow, styled like the Token-usage sub-block
    (mirror lines 646-668). Render nothing until a summary exists or when
    `enabled` is false. `data-testid="quick-session-summary"`.
  - History card as a sibling below the SESSION node: wrap the node in a
    `flex-direction: column` container; switch the body row (~line 546) from
    `alignItems: 'center'` to `'flex-start'` so the Add-a-workflow card
    (lines 749-826) and dashed edge (lines 722-746) are untouched. Disclosure
    lifted verbatim from the `▸/▾ + count` pattern
    (`ArtifactTabRenderer.tsx:1050-1150`, `FeedbackDocPanel.tsx:480-510`):
    collapsed = `▸ History (N)`; expanded = chronological list (oldest first)
    with date labels, capped height + scroll.
    `data-testid="quick-session-history-toggle"` / `"-list"`.

## 8. Tests (AC gate: `pnpm test:unit`)

- `main/src/database/__tests__/sessionSummaries.test.ts` — CRUD + UPSERT
  accumulation semantics + cascade (or explicit-delete) behavior +
  `getConversationMessagesAfter` ordering by `id`.
- `main/src/orchestrator/sessionSummary/__tests__/sessionSummaryScheduler.test.ts`
  (fake timers, fake db, fake summarize fn): arm→fire at 5 min; clear on
  turn-start; empty-delta no-op (no call, watermark unchanged); user-only
  delta no-op; inFlight dedupe; global cap 1; 3-failure suspension; race-guard
  re-arm on `updated_at` movement; disabled-config no-op with pending timer;
  non-quick / archived session no-op; watermark advances only on success;
  cost/calls accumulation; lazy catch-up bypasses timer but not gates, and
  skips a running session.
- `.../__tests__/sessionSummaryQuery.test.ts` (vi.mock of lazyAgentSdk):
  happy-path JSON; fenced JSON; malformed → error; deadline abort; cost
  extraction from the result message.
- `clipDeltaForPrompt` unit tests: caps, final-assistant-message retention,
  determinism.
- Settings round-trip: extend the existing config get/set coverage with
  `sessionSummaryEnabled`. (Note: Settings.tsx frontend tests have known
  pre-existing failures on main — verify against that baseline, don't chase
  them.)
- `QuickSessionCanvas` frontend tests: summary block renders with data;
  hidden when `enabled: false` or no summary; history toggle expands and
  lists entries.

## 9. Commit plan (atomic, in order)

1. `feat: migration 081 session summaries + db CRUD` (migration, models.ts,
   database.ts, db tests)
2. `feat: one-shot haiku session summary query` (sessionSummaryQuery.ts,
   clipDeltaForPrompt, tests)
3. `feat: idle-debounced session summary scheduler` (scheduler, index.ts
   wiring, tests)
4. `feat: sessions:get-summary IPC + lazy catch-up` (shared type, ipc,
   preload, api.ts)
5. `feat: session-summary toggle in Assistant settings` (config.ts,
   configManager.ts, Settings.tsx, round-trip test)
6. `feat: summary card + expandable history on quick-session canvas`
   (QuickSessionCanvas.tsx, useSessionSummary.ts, frontend tests)

## 10. Edge cases and open decisions

- **Sessions deleted mid-flight**: persist step re-checks session existence
  inside the transaction; orphan rows are prevented by cascade/explicit delete.
- **Dynamic-workflow takeover turns**: verify whether Workflow-tool turns land
  in `conversation_messages` for the chat panel; if not, those sittings
  produce no delta and are correctly skipped (the workflow strip has its own
  completion blurbs).
- **Multi-panel sessions**: summarize session-scoped (all panels'
  `conversation_messages`), which is the v1-correct behavior for quick
  sessions (single chat panel in practice).
- **History growth**: unbounded but tiny (one row per sitting). No cap in v1.
- **Default ON** (absent ⇒ enabled) — chosen deliberately; flipping the
  default is a one-line change in the getter. Flag for review.
- **Quick-only scope** — flow runs have workflow structure, step reports, and
  run summaries already; extending to non-quick sessions later only requires
  relaxing the eligibility predicate (§2.9).
- **No re-summarize button, no push subscription, no backfill of pre-feature
  sessions** in v1 (a pre-feature session summarizes from watermark 0 — i.e.
  its full clipped transcript — on its first post-upgrade sitting or lazy
  catch-up; that is the intended cold-start behavior).
