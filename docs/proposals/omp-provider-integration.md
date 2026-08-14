# OMP (oh-my-pi) as a third agent provider

Status: PROPOSAL (2026-08-14). Not yet scheduled.
Prior art: `docs/proposals/codex-provider-integration.md` (the second-provider integration this one
deliberately mirrors and generalizes), `docs/ARCHITECTURE.md` §"Dual-substrate seam".

## 1. Why

Cyboflow today speaks to two agent **harnesses**: Claude Code (SDK + interactive PTY) and OpenAI
Codex (app-server + PTY). Every additional *model family* we want to offer (Gemini, Qwen, DeepSeek,
Kimi, GLM, local models via Ollama/LM Studio, OpenRouter-hosted anything) would otherwise be its own
harness integration.

OMP ([omp.sh](https://omp.sh), `can1357/oh-my-pi`, MIT, TypeScript-on-Bun, fork of Mario Zechner's
Pi) is a **harness, not a model API**: it brings its own agent loop, 31 built-in tools, edit
machinery, session persistence, subagents, MCP client, hook system, and — the point — **60+ model
providers behind one interface** with its own credential management (env vars, OAuth `/login`,
`models.yml`). Integrating OMP as **one** third provider gives cyboflow users the entire multi-model
surface without cyboflow building or maintaining per-provider agent loops. This is categorically
different from integrating OpenRouter, which would hand us raw completions and leave the harness
(tools, edits, approvals, sessions) as our problem.

## 2. Load-bearing OMP facts (verified against source @ v17.3.3, 2026-08-14)

These facts constrain the whole design; each was confirmed in the `oh-my-pi` repo or its `docs/`
tree, not marketing copy.

1. **Bun is a hard runtime requirement.** `packages/coding-agent/src/cli.ts:41-46` version-gates on
   `Bun.semver`; Bun APIs are used across ~177 source files. The in-process SDK
   (`createAgentSession` from `@oh-my-pi/pi-coding-agent`) **cannot be imported into Electron's
   Node main process.** OMP's own reference clients (TS `rpc-client.ts`, Python `omp_rpc`) embed by
   **spawning `omp --mode rpc` as a subprocess** and speaking newline-delimited JSON over stdio.
2. **RPC mode is a complete embedding surface** (`docs/rpc.md`, ~875 lines): commands for
   `prompt`/`steer`/`abort`/`new_session`/`switch_session`, `set_model`/`get_available_models`,
   `set_thinking_level`, `get_session_stats`, `get_last_assistant_text`, `get_messages_page`;
   a `ready` handshake frame with protocol negotiation (v1 = 1 MiB/frame, v2 = chunked to 64 MiB);
   an event stream forwarding the full `AgentSessionEvent` union (token-level `text_delta`s
   included); an `extension_ui_request`/`response` sub-protocol for approval prompts; a host-tool
   bridge (`set_host_tools` → `host_tool_call`/`host_tool_result`). Turn completion is signaled by
   `agent_end` with `isTerminal !== false` — the `prompt` response only acks acceptance.
3. **Full MCP client** — stdio/HTTP/SSE, configured via project `.omp/mcp.json` or user
   `~/.omp/agent/mcp.json`, with `${VAR}` env expansion in `env` values, per-server `timeout`
   (**`0` disables**; default 30s), and automatic import of foreign configs (Claude Code's
   `~/.claude.json` / `.claude/mcp.json`, Codex, Cursor, VS Code …) with OMP-native definitions
   winning name conflicts.
4. **Hooks/extensions are a real pre-tool gate**: a module loaded via `-e`/`--hook` can intercept
   `tool_call` and return `{ block, reason }` or rewrite `input`; a handler throw **fails closed**.
   This is the PreToolUse-equivalent seam, and it is stronger than what Codex offers us.
5. **Approval default is `yolo`** — `tools.approvalMode` defaults to auto-approve-everything.
   Any cyboflow spawn must set the mode explicitly; inheriting OMP's default would bypass our
   permission model entirely.
6. **Sessions**: append-only JSONL trees at `~/.omp/agent/sessions/<encoded-cwd>/…jsonl`
   (redirectable via `--session-dir`), resume by id-prefix or path (`--resume`, RPC
   `switch_session`), fork, `--continue` (per-cwd most-recent). Every assistant `message` entry
   carries a per-turn `usage` block **including a dollar `cost` breakdown**; RPC
   `get_session_stats` returns session rollups.
7. **Model catalog is programmatic**: RPC `get_available_models` (filtered to
   keyless-or-credentialed), model ids are `provider/model` strings, thinking level rides a
   `:level` suffix (`off|minimal|low|medium|high|xhigh|max`), mid-session `set_model` works.
8. **Release cadence is extreme**: 683 changelog releases in ~9 months, majors increment weekly,
   breaking changes are frequent (flagged in the changelog), and an **npm package rename is
   pre-announced**. Version pinning + a contract tripwire are mandatory, not hygiene.
9. **Distribution**: standalone compiled binaries exist (curl installer, brew, Nix) that embed the
   runtime and self-extract the native addon to `~/.omp/natives/<version>`; also installable via
   `bun install -g`.

## 3. Design overview

### 3.1 Provider and runtimes

```
AgentProvider += 'omp'
AgentRuntime  += 'omp-sdk'   // persistent `omp --mode rpc` child process, NDJSON over stdio
              += 'omp-pty'   // interactive OMP TUI over the AbstractCliManager PTY path
SessionAgentRuntime  += both
WorkflowAgentRuntime += 'omp-sdk' only   (same reasoning that excludes codex-pty)
```

`omp-sdk` is transport-honestly an RPC child, but the name keeps the `<provider>-sdk` convention
that `codex-sdk` (really an app-server) established; UI label: **"OMP"** / **"OMP terminal"**.
Per the codex-exec lesson (`codex-provider-integration` retro): we declare **no** runtime we are
not shipping — exactly these two.

The structural rhyme that makes this cheap: **`OmpSdkManager` is shaped like `CodexSdkManager`**
(persistent JSON-protocol child per panel/lane, warm-entry lifecycle, event projector into
`AgentStreamEvent[]`, approval/question bridges into the shared routers), and **`OmpPtyManager` is
shaped like `CodexPtyManager`** (binary discovery ladder, permission flags, raw `pty-output`).
Everything downstream of `AgentStreamEvent` — `agentStreamAdapter`, `MessageProjection`,
`UnifiedChatView`, `RawEventsSink`, `agent_invocations` — is already provider-blind and needs zero
changes (verified: `isAgentStreamEvent` dispatches on event `type`, not provider).

### 3.2 Tier placement (what OMP serves, in order)

Using the orchestration-capability tiers (see §"capability registry" in the research notes /
`codex-provider-integration.md`):

| Tier | What | OMP verdict |
|---|---|---|
| T0 quick chat sessions | `omp-sdk` structured + `omp-pty` terminal | **Phase 1** — full parity path exists |
| T1 programmatic per-step workflow agents | `omp-sdk` | **Phase 2** — and with *fewer* degradations than codex-sdk: `get_last_assistant_text` restores `resultText` (codex loses it), and the gating hook can honor `disallowedTools` (codex ignores it) |
| T2 main orchestrator session | `omp-sdk` | **Phase 3, explicitly deferred** — needs a per-provider prompt envelope, question-gate parity, subagent role mapping |
| T3 eval juror / visual verifier | one-shot query | **Phase 3 / open** — RPC exposes no per-prompt JSON-schema output; see §9 |

The hard rule from the codex retro applies: `workflow_runs.substrate` piggybacking on `'sdk'` makes
a new runtime **silently eligible for programmatic mode**. Phase 1 must add an explicit
tier-eligibility guard for `omp-sdk` in `workflowRegistry.createRun` (reject workflow runs until
Phase 2 lands; quick `__quick__` sentinel only), rather than discovering T1 by accident.

### 3.3 Distribution & auth: delegate to OMP (v1)

- **No bundling in v1.** Discovery ladder mirrors `codexPtyManager`: explicit custom path setting →
  `findExecutableInPath('omp')` → version probe. Onboarding/Settings show "install via
  `curl -fsSL https://omp.sh/install | sh` or `brew install can1357/tap/omp`". Bundling per-platform
  binaries (the `@openai/codex` asarUnpack pattern) is a later, deliberate packaging project —
  it drags in signing/notarization and the release runbook.
- **No credential UI in v1.** OMP owns provider credentials (`~/.omp`, env vars, OAuth `/login`,
  `models.yml`). Cyboflow's availability probe = binary present + version OK + RPC
  `get_available_models` returns ≥1 model. The Settings/Integrations card for OMP shows detection
  state and links out ("run `omp` in a terminal and `/login <provider>`"), exactly the shape of the
  Codex ChatGPT-login card. This removes the entire per-provider secret-management scope from v1.

### 3.4 Version discipline

- `OMP_MIN_SUPPORTED_VERSION` (floor, hard-refuse below) + `OMP_TESTED_VERSION` (soft: log + a
  one-time settings banner "running an untested OMP version") — a hard equality pin like Codex's
  `CODEX_EXECUTABLE_VERSION` would break daily at OMP's release cadence.
- A **contract test in the sdkContract style** (`main/src/test/fakes/__tests__/sdkContract.test.ts`
  precedent): committed fixtures of the RPC `ready` frame, one full turn's event stream, and the
  `get_available_models` / `get_session_stats` response shapes, asserted against the discriminants
  our projector and manager actually read. Protocol negotiation pins v1 framing; we refuse a ready
  frame whose `supportedProtocolVersions` excludes 1.
- The pre-announced npm rename does not affect us in v1 (we ship no npm dependency on OMP — we
  spawn the user's binary).

## 4. Phase 0 — generalize before adding (the "don't copy the wart a third time" pass)

The codex integration left ~5 P0 sites that would **silently misroute an `omp` runtime to Claude**
and ~10 P1 shape problems. Phase 0 is a behavior-neutral refactor, landable and testable on its own,
with the full suite green before any OMP code exists.

P0 (silent misrouting):
1. `providerForRuntime` prefix-sniff (`shared/types/agentRuntime.ts:97-99`, duplicated in
   `main/src/services/panelLane.ts:45-47` and `frontend/src/components/cyboflow/agentRuntimeUi.ts`)
   → one `RUNTIME_PROVIDER_PREFIXES`-driven map in `shared/`, re-exported; unknown prefix **throws**
   in dev / floors with a logged error in prod, never silently `'claude'`.
2. `SubstrateDispatchFacade` — Codex rides two optional trailing constructor params and
   `=== 'codex-sdk'` tests (`substrateDispatchFacade.ts:224-231, 327-345, 355-369`) → a
   `Map<PanelLane | AgentProvider, AbstractCliManager>` registry with explicit registration at boot;
   `resolvePanelOwner` (`main/src/index.ts:2542-2556`) loses its silent `default:`-to-Claude arm.
3. DB CHECK constraints hardcode `('claude','codex')` on `sessions` (059/060), `workflow_runs`
   (062/063), `agent_invocations` (065). SQLite cannot ALTER a CHECK → **table-rebuild migrations**
   (create-new → copy → drop → rename, preserving indexes + the `agent_invocations` FK). We widen
   to include `'omp'` in the same rebuild (one rebuild, not two). Schema parity: update
   `scripts/verify-schema-parity.js` + `entitySchemaParity.test.ts`.
4. `normalizeAgentModelSelection`'s claude-else-codex binary (`shared/types/agentModels.ts:87-104`)
   → per-provider model-family predicate registry. OMP's discriminator is structural: its model ids
   contain a `/` (`provider/model`).
5. `AGENT_PROVIDER_DISABLED_CODE` regex + `parseAgentProviderDisabled` coercion +
   `resolveAgentProviderAccess` (`agentRuntime.ts:164-212`) → provider-list-driven.

P1 (shape, same pass):
6. `WorkflowAgentConfig.codexModel` → generalized `providerModel?: string` (keyed by the resolved
   provider), with `codexModel` kept as a read-compat alias during migration; touches
   `effectiveAgents.ts`, `agentOverrideRouter.ts`, `spawnStepRunner.ts:244-246`, the Zod schema,
   `agent_overrides.codex_model` (add `provider_model`, backfill, read both), editor state, tRPC.
7. Inline `z.enum(['claude','codex'])` / runtime-list literals (`trpc/routers/variants.ts`,
   `runs.ts`, `experiments.ts`, `ipc/config.ts` ×2, `insightsQueries.ts:2616`,
   `shared/types/insights.ts:360`) → `z.enum(AGENT_PROVIDERS)` / `z.enum(WORKFLOW_AGENT_RUNTIMES)`.
8. Provider-named detection/catalog verticals (`codex:detect`, `models:get-codex-catalog`,
   `CodexDetectionResult`, `useCodexModelCatalog`) → `providers:detect(provider)` +
   `models:get-catalog(provider)` + a `Record<AgentProvider, CatalogState>` store, with the old
   channels kept as thin delegates until the frontend flips.
9. Demo-mode `instanceof` grafts (`cliManagerFactory.ts:34-48, 126-185`) → boot wiring depends on
   the manager interface, delete the adapter.
10. Per-runtime **capability flags as data** (`supportsEffort`, `supportsResume`,
    `supportsResultText`, `supportsStructuredPanel`, `supportsMcp`, `worksInWorkflows`) on the
    `CliToolDefinition`/provider registry, replacing scattered `=== 'codex-pty'` special cases
    (`SessionStartWizard`, `ABTestLaunchModal`, `useQuickSession`, `QuickSessionComposer`).
11. The 3–4 hand-written provider×runtime consistency guards (`workflowRegistry.ts:1172-1185`,
    `runs.ts:1144-1155`, `experiments.ts:2251-2262`, `session.ts:910-929`) → one
    `assertProviderRuntimeConsistent` in `shared/`.
12. Prompt envelopes → `PROVIDER_PROMPT_ENVELOPES: Record<AgentProvider, string | null>` in
    `workflowPromptRenderer.ts` (Codex's 8-bullet envelope moves in; `omp` gets `null` until
    Phase 3).

Acceptance for Phase 0: `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration`
green; zero behavior change (existing codex/claude suites are the regression net); the new
provider-registry unit tests assert that an *unknown* runtime string fails loudly everywhere the
old code silently floored to Claude.

## 5. Phase 1 — T0 quick sessions

### 5.1 `OmpSdkManager` (`main/src/services/panels/omp/ompSdkManager.ts`)

Extends `AbstractCliManager`; the CodexSdkManager blueprint applies almost 1:1:

- **Process model**: one persistent `omp --mode rpc` child per panel (and later per `spawnKey`
  lane), spawned via the discovered binary. Warm-entry lifecycle: `WarmOmpEntry` keyed by panel,
  15-min idle TTL, kill switch `CYBOFLOW_DISABLE_OMP_WARM=1`, fingerprint = sha1(exe path+version,
  cwd, flags, env, model, session dir). RPC gives a true `abort` command, so interrupt is a
  first-class RPC call, not a process kill.
- **Spawn flags** (explicit, never inherited defaults):
  `--mode rpc --approval-mode <mapped> --model <selection> --session-dir <cyboflowDataDir>/omp-sessions/<panelId>
  --no-title -e <cyboflowGateExtension> [--resume <path>]`.
  Explicit `--approval-mode` is **non-negotiable** (OMP defaults to yolo, fact §2.5).
  Redirecting `--session-dir` keeps cyboflow-spawned OMP sessions out of the user's personal
  `~/.omp` session list, sidesteps the encoded-cwd collision class, and makes cleanup a directory
  delete; resume still works by path.
- **Turn contract**: `spawnCliProcess` sends `prompt` and resolves at the first `agent_end` with
  `isTerminal !== false` (per-logical-turn resolution, same contract the warm Claude SDK path
  keeps); rejects on `turn.error`-equivalents. `'spawned'`/session-info/`'exit'` are emitted per
  logical turn, mirroring the warm-SDK convention so `events.ts` needs nothing new.
- **Handshake**: read the `ready` frame, verify protocol v1, `negotiate_protocol` v2 opportunistically
  (large-frame safety), then `switch_session`/fresh per resume state, then prompt.
- **External session id**: OMP session file path (returned by `get_state`/session events) captured
  once via `AgentInvocationStore.captureExternalSessionId` — resume target for follow-up turns and
  app-restart recovery (first post-restart turn cold-spawns with `--resume <path>`).
- **Event projection** (`main/src/services/panels/omp/ompEventProjector.ts`): OMP
  `AgentSessionEvent` → `AgentStreamEvent[]`, stamped `{provider:'omp', runtime:'omp-sdk'}`.
  Mapping sketch: `message_start/end` (assistant) → `AgentAssistantMessageEvent` with
  text/thinking/tool-call blocks; `tool_execution_end` → tool-result blocks; `agent_end` →
  `AgentResultEvent` carrying accumulated usage **and `total_cost_usd`** (OMP reports per-turn
  dollar cost — unlike Codex, OMP runs will have real `run_usage.cost_usd`; stored verbatim per
  the run-cost source-of-truth rule, flagged in UI as harness-estimated). `message_update`
  `text_delta`s are **dropped in v1** (codex-parity refetch model; live-tail is a later nicety) —
  same for the raw-notification audit sink (`event_type='omp_rpc_event'`, deltas excluded, the
  `rawNotificationSink` lesson).
- **Usage note**: OMP reports usage per assistant message (Claude-style), so the
  `insightsQueries.ts:536-541` result-usage fallback heuristic is untouched — we emit usage on
  projected assistant messages, and the result event carries the rollup from `get_session_stats`.
- **Approval gate**: see §5.3.
- **Question gate**: v1 = none (OMP's `ask` tool is not bridged yet; quick sessions surface
  questions as plain assistant text). Phase 3 bridges it. This matches where claude-interactive
  still is today.

### 5.2 `OmpPtyManager` (`main/src/services/panels/omp/ompPtyManager.ts`)

CodexPtyManager blueprint: discovery ladder (custom path → PATH), version probe via the shared
`cliVersionProbe.ts` (its shebang/`usedNodeFallback` handling is reusable as-is),
`buildCommandArgs` = `--approval-mode <mapped> [--model <selection>] [--continue]`, raw
`pty-output` with the 200 KB backlog cap, `relayUserTurn`/`relayRawInput`/`resizePanel`.
Improvement over codex-pty: `continuePanel` respawns with `--continue` scoped to the worktree cwd
(OMP's per-cwd breadcrumb makes this actually resume), instead of kill+fresh.
Approvals surface natively in the TUI (same explicitly-documented boundary as codex-pty: they do
not enter the review queue). No MCP, no structured side-channel — T0 floor by design.

### 5.3 Permission-mode mapping + the gating extension

Two composed layers, one source of truth (`ompPermissionConfigForMode`, the
`codexPermissionFlagsForMode` analogue, shared by both lanes):

| Cyboflow mode | OMP `--approval-mode` | Gating extension behavior (`omp-sdk` only) |
|---|---|---|
| `default` | `always-ask` | `tool_call` → orch-socket ask → ApprovalRouter decision |
| `acceptEdits` | `write` | gate exec-tier only |
| `auto` | `write` | gate exec-tier; allowlist via merged permission rules |
| `dontAsk` | `yolo` | log-only |

The **gating extension** is a small cyboflow-authored OMP hook module (shipped inside our app
resources, passed via `-e <path>`): on `tool_call` it connects to `CYBOFLOW_ORCH_SOCKET`, requests
a decision keyed by `CYBOFLOW_RUN_ID`, and returns `{block, reason}` on deny. This is the
**interactive-Claude shell-hook pattern** (`preToolUseShellHook.ts`) ported to OMP's hook API, and
it fails closed (a hook throw blocks the call — OMP-documented semantics). It also enforces
`disallowedTools` (env `CYBOFLOW_DISALLOWED_TOOLS`), which closes a real Codex gap
(`spawnStepRunner.ts:62-64` deny-list is unenforced on codex-sdk).
Open verification item: whether OMP fires `tool_call` hooks inside its **subagents** (its docs say
subagents run forced-yolo; hook scope there is UNKNOWN). Until verified, the extension also denies
OMP's `task` tool outside `dontAsk` mode, so gating cannot be escaped by delegation.

In parallel, RPC `extension_ui_request` frames of kind `confirm` (OMP's own approval prompts, e.g.
the bash safety-overrides that fire even in yolo) are answered by a thin
`ompApprovalBridge` → ApprovalRouter — the codex `approvalBridge.ts` mirror, so nothing ever hangs
waiting on a TUI that does not exist.

### 5.4 MCP (`cyboflow_*`) injection — worktree sessions only in v1

- Write `<worktree>/.omp/mcp.json` at spawn (same seam as `writeInteractiveMcpConfig`; `.omp/`
  joins `.cyboflow/` in the worktree-local git exclude):

  ```json
  { "mcpServers": { "cyboflow": {
      "command": "<node>", "args": ["<cyboflowMcpServer.js>"],
      "env": { "CYBOFLOW_RUN_ID": "${CYBOFLOW_RUN_ID}",
               "CYBOFLOW_ORCH_SOCKET": "${CYBOFLOW_ORCH_SOCKET}" },
      "timeout": 0 } } }
  ```

  `${VAR}` expansion pulls from the **omp process env**, which we inject per spawn — one static
  file works for concurrent lanes sharing a worktree with different run ids. `timeout: 0` is
  mandatory (OMP's 30s default would kill any blocking human gate — the Codex
  `tool_timeout_sec: 7d` lesson). Implementation must verify expansion resolves from process env;
  fallback is a wrapper script reading env.
- Process env per spawn: `CYBOFLOW_RUN_ID`, `CYBOFLOW_ORCH_SOCKET`, `CYBOFLOW_RUN_ARTIFACTS_DIR`
  (do **not** repeat the codex-sdk artifacts-dir omission), login-shell PATH merge,
  `electronRunAsNodeGuardEnv`, `managedTestConcurrencyEnv`.
- OMP will also auto-import MCP servers from the project's `.mcp.json` / the user's
  `~/.claude.json` (fact §2.3). For quick sessions this is parity with claude-sdk's base-server
  merge; OMP-native definitions win name conflicts, so our `cyboflow` entry cannot be shadowed.
- **In-place (non-worktree) quick sessions skip cyboflow MCP in v1** — writing `.omp/` into the
  user's real repo is intrusive, and OMP has no `--mcp-config <path>` flag today. Follow-up worth
  doing: upstream exactly that flag (OMP is MIT and accepts PRs); it dissolves this limit and the
  git-exclude dance.

### 5.5 Everything else in Phase 1 (mechanical, registry-driven after Phase 0)

- Types/registry: `'omp'` + both runtimes in `agentRuntime.ts` arrays/labels, `PanelLane` +
  `resolvePanelLane` arms, effort scale `OMP_EFFORT_LEVELS = off|minimal|low|medium|high|xhigh|max`
  (adds `off`/`minimal` to `ALL_EFFORT_LEVELS`; `normalizeEffortSelection` handles cross-provider
  drops), model-family predicate (contains `/`).
- Factory/boot: `registerOmpSdkTool`/`registerOmpPtyTool` in `cliManagerFactory.ts` (priorities
  below codex), manager-registry entries in the facade, `resolvePanelOwner` arms, exit/output
  listeners + `startOmpSdkTurn` mirror of `startCodexSdkTurn` in `ipc/session.ts`,
  `ptyPanelDispatch` arm, demo-mode entries via the Phase-0 interface (no instanceof grafts).
- Quick-session create path: runtime validation, provider-access gate, substrate projection
  (`omp-sdk` ⇒ `substrate='sdk'`, `omp-pty` ⇒ eager PTY spawn) in `session.ts` +
  `createQuickSessionCore.ts`.
- Frontend: `SubstrateSelector` rows (+ v1 caveats panel: "no question gate; approvals for the
  terminal lane stay in the terminal"), `AgentPermissionModeSelector` option set,
  model picker via the generalized catalog store (RPC `get_available_models`, 5-min cache,
  grouped by OMP provider prefix), `EffortPill`/`ModelPill` via registries, `PanelTabBar`/
  `RunChatView` labels via registry, onboarding + Integrations detection card.
- Migrations (three, numbered at rebase time — 098-100 are taken in this tree and sibling branches
  already claim 101/102; renumber-on-rebase is standing practice): the Phase-0 CHECK-widening
  rebuilds already include `'omp'`; net-new here is only `agent_overrides.provider_model` if not
  landed in Phase 0.
- Session-summary scheduler: OMP excluded by the existing `!== 'claude'` gate — fine, note only.

Acceptance: quick `omp-sdk` chat round-trips (prompt → structured panel → follow-up with resume →
interrupt → model switch), quick `omp-pty` terminal session works with `--continue` restart,
permission modes verified against a scripted deny, catalog renders, provider toggle removes OMP
everywhere, full gate green. Live smoke against a real `omp` install before calling it done
(per the standing "green gate proved nothing" lesson).

## 6. Phase 2 — T1 programmatic per-step agents

Lift the Phase-1 guard; add:

1. `WORKFLOW_AGENT_RUNTIMES += 'omp-sdk'`; `workflowRegistry.createRun` ladder + substrate
   projection (piggyback `'sdk'`, same as codex, with the consistency guard); `runs.start` enum via
   Phase-0 shared enums; variant editor + step inspector + agent editor pick up `omp-sdk` from the
   registry with `providerModel`.
2. `spawnCliProcess` returns `CliSpawnOutcome { resultText }` — after terminal `agent_end`, read
   the final assistant text from the already-projected messages (fallback:
   `get_last_assistant_text`). **This makes omp-sdk the first non-Claude runtime with working
   code-review verdict parsing, task-verify FAIL routing, and visual-fence composition**
   (`workflowController.ts:961-990, 1017-1029` stop being dead paths).
3. `spawnKey` fan-out lanes: one RPC child per lane (concurrent children per worktree are fine —
   session files are per-lane under our redirected `--session-dir`).
4. `systemPromptAppend` → `--append-system-prompt` (OMP has the flag natively; no prompt-head hack
   needed).
5. `disallowedTools` → gating extension env (already built in Phase 1).
6. Effort → `set_thinking_level` / model `:suffix` from the normalized selection.
7. Hermeticity knobs for lane spawns (decide during implementation, default conservative):
   `--no-extensions --no-skills` to keep user-global OMP customization out of workflow lanes while
   leaving project rules/context files on; quick sessions keep the user's full OMP environment.
8. Decide `task.isolation` interplay: OMP subagent overlay/rcopy isolation inside a cyboflow git
   worktree is untested — v1 sets `task.isolation.mode: none` via config overlay for lane spawns.

Not required (host owns gates at T1): question bridge, subagent role mapping, prompt envelope.

## 7. Phase 3 — T2 orchestrator + T3 juror/verifier (deliberately later)

- T2 needs: an OMP prompt envelope (`PROVIDER_PROMPT_ENVELOPES.omp`) redirecting AskUserQuestion →
  `cyboflow_request_user_input` and mapping `cyboflow-*` subagent roles onto OMP agent definitions;
  a `.omp/agents/*.md` writer alongside `workflowBundleWriter` (OMP discovers project agents there;
  frontmatter differs from `.claude/agents` — name/description/systemPrompt); question-gate bridge
  (OMP `ask` tool or `extension_ui_request` `select`/`input` kinds → QuestionRouter); resume/nudge
  via `switch_session`. The monitor and final-gate handover stay Claude — same conscious decision
  already made for Codex.
- T3 blocker: RPC has no per-prompt JSON-schema structured output (the SDK's `outputSchema` is
  in-process-only). Options, in preference order: (a) upstream an `output_schema` field on the RPC
  `prompt` command; (b) schema-in-prompt + parse-with-retry (the pre-`strictOutputSchema` world —
  known fragile); (c) defer. Recommendation: (a)/(c) — do not ship (b) into the eval jury.
  `insightsQueries.ts:2602-2634` jury parsing and `shared/types/insights.ts:360` must accept
  `'omp'` slots when this lands (covered by Phase-0 item 7).

## 8. Security posture (net-new surface, called out explicitly)

1. **OMP's yolo default** — every cyboflow spawn passes an explicit approval mode; a missing flag
   is a bug class, so `buildCommandArgs` asserts it and a unit test locks it.
2. **OMP extensions run arbitrary TS in-process with no isolation.** Cyboflow loads exactly one
   extension it ships itself (the gating hook); lane spawns pass `--no-extensions` so user-global
   extensions cannot inject into workflow agents. Quick sessions inherit the user's own extensions
   knowingly (their machine, their OMP config).
3. **`.env` auto-load**: OMP loads `<cwd>/.env` into provider-credential resolution. A worktree
   `.env` is the repo's own file — same exposure Claude/Codex tools already have via shell access,
   but note it feeds OMP's *credential* chain; no action beyond documentation.
4. **The orch socket has no peer auth** (known standing finding). The gating extension adds one
   more client class to that socket; it does not widen the existing exposure, but the socket-auth
   fix rises in priority with a third writer.
5. **Foreign-MCP auto-import** means an OMP session may connect servers the user configured for
   other tools. Name-conflict precedence protects the `cyboflow` server; the rest is the user's
   ambient config, same trust stance as claude-sdk's `~/.claude.json` merge.
6. **ToS**: multi-account/coding-plan providers routed through OMP (Copilot, Cursor plans, …) carry
   their own terms; cyboflow does not proxy or store those credentials and surfaces OMP as the
   integration point. Same "user's own account" stance as the interactive Claude substrate.

## 9. Cost/usage accounting

- `run_usage.cost_usd` ← OMP's per-turn `cost.total`, summed and emitted as `total_cost_usd` on the
  projected result event, stored verbatim (source-of-truth rule). It is OMP's catalog-priced
  estimate, not a provider invoice — UI marks OMP cost rows "estimated (OMP)".
- Tokens per assistant message (Claude-style cadence), so existing insights heuristics hold without
  the codex result-fallback path.
- `agent_invocations` rows carry `('omp', 'omp-sdk'|'omp-pty', model, session-file path)` —
  provider-neutral table, no schema change beyond the Phase-0 CHECK widening.

## 10. Testing & CI

- Unit suites mirroring the codex set: `ompSdkManager.test.ts` (warm lifecycle, fingerprints,
  turn contract, kill paths), `ompRpcClient.test.ts` (framing incl. 1 MiB cap + v2 chunking,
  ready-handshake refusal), `ompEventProjector.test.ts` (every event type → envelope),
  `ompApprovalBridge.test.ts`, `ompPermissionConfig.test.ts`, `ompPtyManager.availability.test.ts`,
  `ompMcpConfigWriter.test.ts` (env-expansion contract), gating-extension tests (deny/allow/throw
  fails closed) run against a stub socket.
- The RPC contract-fixture test (§3.4).
- Cross-cutting: every Phase-0 registry test, `panelLane`, facade dispatch, migration rebuild tests
  (parity + FK preservation), quick-create validation, picker/store frontend tests.
- CI: all in the unit tier (`panels/omp/` is outside the mocked-SDK itest scope, same as
  `panels/codex/`); nothing under `panels/claude/` should need touching except the shared facade —
  if it is touched, `pnpm test:integration` is mandatory per standing rule.
- Manual smoke checklist (a real `omp` binary): the Phase-1 acceptance list + a scripted
  "deny in default mode / allow in dontAsk" probe + a mid-session `set_model` flip across two OMP
  providers (e.g. an Anthropic model → a local Ollama model) — the actual product promise.

## 11. Risks & open questions

| # | Risk / unknown | Mitigation |
|---|---|---|
| 1 | OMP's release velocity breaks the RPC contract under us | min-version floor + tested-version banner + contract fixtures; we spawn the user's binary, so breakage is visible, not silent |
| 2 | `${VAR}` mcp.json expansion source unverified (process env vs login env) | implementation-week probe; wrapper-script fallback |
| 3 | Hook (`tool_call`) scope inside OMP subagents unknown | deny `task` tool outside `dontAsk` until proven; upstream question filed |
| 4 | No RPC structured-output → T3 blocked | defer T3; consider upstreaming `output_schema` |
| 5 | No `--mcp-config` path flag → in-place sessions lack `cyboflow_*` | v1 limitation; upstream PR candidate |
| 6 | `agent_end.isTerminal` semantics (maintenance resumes) could double-resolve a turn | manager treats only `isTerminal !== false` as terminal and ignores post-terminal events until next prompt; fixture-tested |
| 7 | OMP TUI inside our PTY may probe terminal capabilities differently than codex/claude TUIs | smoke early in Phase 1; `omp-pty` is severable from the phase if it stalls |
| 8 | Bun/native-addon issues on user machines (addon self-extracts to `~/.omp/natives`) | availability probe runs a real `--version` + RPC ready handshake, so a broken install fails at detection, not mid-session |
| 9 | Two more lanes multiply the remaining frontend ternaries we did not catch | Phase-0 capability-flag registry + a grep-audit task (`'codex'` / `codex-` in `frontend/src`) at the end of Phase 1 |
| 10 | Migration-number collisions with unpushed sibling branches (101/102 claimed) | renumber at rebase, standing practice |

## 12. Non-goals (v1)

Bundled OMP binary; per-provider credential UI; OMP as main orchestrator (T2) or juror (T3);
token-level live-tail for omp-sdk; question-gate bridge; `omp-pty` in workflows; OMP subagent
(`task`/vibe-mode) orchestration under cyboflow flows; Windows/Linux validation (macOS first, same
as the rest of the app).

## 13. Rollout order

Phase 0 (generalization, behavior-neutral) → Phase 1 (T0 quick sessions, feature-flagged by the
provider-access toggle defaulting **off** until smoked) → Phase 2 (T1 per-step agents) → Phase 3
(T2/T3, each gated on its open questions). Each phase is independently landable, gate-green, and
live-smoked before the next starts.
