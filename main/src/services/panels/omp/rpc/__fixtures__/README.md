# OMP RPC contract fixtures

Captured from the **real `omp` binary, v17.3.2** (2026-08-14) run as

```
omp --mode rpc --no-extensions --no-skills --no-session --no-title \
    --approval-mode always-ask --model haiku --thinking off
```

These are wire captures, not hand-written examples. `__tests__/ompRpcContract.test.ts`
pins every discriminant `ompRpcClient` / `ompEventProjector` / `ompUsageAccumulator`
read against them, so a protocol change shows up as a named failing test instead of
silently reshaping the chat stream. Regenerate deliberately, and re-verify the three
modules against the new capture before updating them.

| File | Capture |
| --- | --- |
| `ompTurnFrames.jsonl` | All 19 stdout frames of one complete prompt turn ("Reply with exactly: ok"), in order. |
| `ompReadyFrame.json` | The startup ready frame. |
| `ompNegotiateProtocolResponse.json` | `negotiate_protocol` → v2 accepted. |
| `ompGetStateResponse.json` | `get_state` on a fresh session. |
| `ompAvailableModelsResponse.json` | `get_available_models`. |
| `ompSessionStatsResponse.json` | `get_session_stats` — CUMULATIVE, never a per-turn source. |
| `ompLastAssistantTextResponse.json` | `get_last_assistant_text` on an empty session. |
| `ompUnknownCommandResponse.json` | An unknown command's failure — note the ABSENT `id`. |

## Sanitization

Shapes are byte-faithful; only these substitutions were applied, and only to values
that identify a machine or a specific API call:

- `sessionId` → `01a00000-0000-7000-8000-000000000000`
- `responseId` → `msg_01FIXTUREASSISTANT00000`
- `get_state`'s `systemPrompt` → a single placeholder line (it is OMP's full system prompt)

Three arrays were **truncated for reviewability**, keeping element shape intact:
`available_commands_update.commands` (83/66 → 2), `get_available_models.data.models`
(493 → 3), and `get_state.data.dumpTools` (the full tool catalogue → 2). No key was
added, removed, or renamed anywhere.

## Facts these captures established

Each of these contradicted or was absent from the written docs, so the capture is the
authority:

- `agent_end` carries `isTerminal: true` explicitly on the normal path (the RPC layer
  always stamps it — `agent-session.ts:2739`), so the `isTerminal !== false` rule is
  about tolerating *older* runtimes that omit it, not the current one.
- An unknown command answers with **no `id`** while echoing `command`, so id-only
  correlation would leak a pending request forever.
- `get_last_assistant_text` on an empty session returns `{}` — the `text` key is
  ABSENT, not `null` as `rpc.md:320` implies.
- `get_state` omits `sessionFile`/`sessionName` entirely under `--no-session`, and
  returns the FULL model row rather than the `{provider, id}` pair `rpc.md:249` shows.
- A model `id` is bare (`claude-3-5-sonnet-20240620`) with the OMP-side provider in a
  separate `provider` field.
- The per-message `usage` token fields are disjoint: `input + output + cacheRead +
  cacheWrite === totalTokens`.
