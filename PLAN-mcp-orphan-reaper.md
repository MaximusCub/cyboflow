# PLAN: orphaned `cyboflowMcpServer` processes — root cause + self-termination fix

> **Revision 5 — IMPLEMENTED.** Shipped across five commits (`65dd4fd4`…`59902d1a`) plus the
> round-4 review fixes. Two defects found after implementation are recorded inline: the age gate
> measured the wrong quantity (§7), and the production tripwire was constructed without a logger,
> so it observed correctly and reported to nobody — its `logger` is now a required constructor
> argument, making that instance impossible to build.
>
> Rev 1 proposed an external `ps` reaper and called the root cause unknown.
> Rev 2 established the root cause from source and moved the fix inside the server. Rev 3
> fixed rev 2's coverage and observability defects. Rev 4 fixes rev 3's own defects, found in
> adversarial review round 3 — most importantly a verification channel that could not observe
> the thing it verified. **[revN error]** markers record what was wrong so it is not reintroduced.

## 1. Observed problem

On 2026-08-10 a host scan found **40 orphaned `cyboflowMcpServer.js` processes**:

- All `PPID == 1` (reparented to launchd — spawner exited).
- Ages **2h29m – 2d20h**; the app (PID 6478) had been up **3d21h**.
- Combined RSS **214 MB** (measured sum of the `ps` RSS column across all 40; individual
  sizes 4.6–7.8 MB, modal 4.6 MB).
- All had the **Electron-binary** interpreter shape; the 13 correctly-parented servers alive
  at that moment were mostly the plain-`node` shape.

All 40 exited cleanly on SIGTERM (`cyboflowMcpServer.ts:2773-2781`). Orphans accumulated
**during a single app uptime**, so this is unbounded growth on a long-running app.

## 2. Root cause — ESTABLISHED

**The server already has an exit-on-peer-death path, tethered to the wrong peer.**

`cyboflowMcpServer.ts:132`:

```ts
socket.on('close', () => { console.error('[Cyboflow MCP] IPC socket closed — exiting'); process.exit(0); });
```

That socket is `CYBOFLOW_ORCH_SOCKET` — **app-global**, not per-session. So the server's
lifetime is bound to the Electron main process, while its *useful* lifetime ends when its
`claude` spawner dies. Between those two moments it is a live process nothing can reach and
nothing will kill.

The false premise is written down at `cyboflowMcpServer.ts:149-150`:

```
// timeoutMs null = wait forever. Safe because a pending entry cannot
// outlive the run: the IPC socket closing exits this whole process.
```

"cannot outlive the run" is false — the socket outlives every run in the app's lifetime.

Two verified facts complete it:

1. **Nothing exits on stdin EOF.** The only `process.exit` calls are lines 23, 62, 132, 2775,
   2780, 2797.
2. **The SDK does not supply it.** `@modelcontextprotocol/sdk@1.29.0`
   `StdioServerTransport.start()` attaches only `'data'` and `'error'` to stdin
   (`dist/esm/server/stdio.js:31-32`).

Even if the transport fired `onclose`, the ref'd `net.Socket` would keep the loop alive.

This explains every observation: mid-uptime accumulation, every orphan younger than app
uptime, no cross-boot residue.

### [rev1 errors] — hypotheses that were wrong

- Rev 1 called the root cause unestablished and proposed a diagnosis phase. It was one grep away.
- Rev 1's H2 (missing `ELECTRON_RUN_AS_NODE` guard) was never a candidate: a genuinely
  unguarded spawn boots full Electron instances, not 4.6 MB run-as-node processes. Real bug
  (§6), unrelated cause.
- Rev 1's Phase-0 evidence step was inoperable: `ps -axeo pid,command` prints the command
  line, not env. macOS env inspection is `ps eww -p <pid>`.

### Likely, not load-bearing: the interpreter-shape split

`killProcessTree` is used by the PTY substrate and never by `claudeCodeManager.ts`. PTY
teardown tree-kills descendants; SDK teardown kills only the `claude` process. So SDK-substrate
sessions orphan their servers and PTY sessions do not. **No part of this plan depends on it.**

## 3. Why nothing reaped them

`index.ts` boots two process reapers — `PrototypeServerReaper` (`:741`) and
`CodexBrokerReaper` (`:764`, `:808`). Neither matches `cyboflowMcpServer.js`, and there is no
periodic sweep.

**[rev2 error]** Rev 2 said `McpServerLifecycle.stop()` reaps the singleton. It has **no
production call site** — only `.start()` at `index.ts:3259`. The singleton also dies solely by
fd closure at app exit. This strengthens the "line 132 is the only tether" story.

## 4. Design principle

**The fix belongs inside the server.** The server is the only party that can know without
ambiguity or race that its spawner is gone — it holds the pipe and can read its own
`process.ppid`. Every external mechanism must *infer* that, which is what forces `ps` scanning,
PID-reuse races, scope guards, and kill authority.

**Corollary (rev 3):** once the server is the only actor, nothing outside it will report that
the actor is broken. Self-termination therefore requires an explicit, independent verification
channel — §7. **[rev2 error]** Rev 2 accepted the principle and omitted the corollary.

## 5. Phase 1 — the fix (`cyboflowMcpServer.ts`)

**(a) `process.ppid` watchdog — PRIMARY.** An `unref()`'d 60 s timer: if `process.ppid === 1`,
shut down. On macOS this has **no false-positive class**: Darwin has no subreaper API, orphans
reparent to launchd unconditionally, none of these servers are ever launchd-spawned, and
`process.ppid` is a live `getppid()`, not a cached value. So `ppid === 1` while the spawner
lives is impossible.

*Known false negative:* under a Linux child-subreaper a dead parent reparents to the subreaper,
not to 1, so this never fires. Fail-safe, and cyboflow is macOS-only — note it in the docstring.

**(b) Exit on stdin EOF — FAST PATH.** Fires in milliseconds rather than up to 60 s:

```ts
process.stdin.on('end',   () => shutdown('stdin EOF'));
process.stdin.on('close', () => shutdown('stdin closed'));
```

**Install at module scope, alongside the SIGTERM handlers at `:2773` — never inside `main()`.**
`'end'` is emitted once; a listener attached after `await server.connect()` (`:2794`) misses an
already-emitted `'end'` forever, recreating the exact orphan class this plan exists to kill.
Module scope is always safe because no I/O events are delivered before the event loop starts.

*Known false negatives:* `StdioServerTransport.close()` **pauses stdin** when it was the sole
`'data'` listener (verified in SDK `dist/esm/server/stdio.js`), after which EOF is never
detected; and a third party holding the write end also suppresses it. Attaching `'end'`/`'close'`
neither resumes nor consumes the stream, so it cannot perturb the transport.

**[rev2 error] — the hierarchy was inverted.** Rev 2 made stdin EOF primary and the ppid check
a "backstop… worth its complexity?". It is the reverse: ppid has no false-positive *or*
false-negative class on macOS; stdin EOF has two identified false-negative classes. ppid is the
**guarantee**, stdin EOF the **optimization**. Keep both.

**(c) `shutdown()` must be idempotent.** Mirror the SIGTERM handler (`:2773-2776`):
`ipcClient.end()` then `process.exit(0)`. `'close'` follows `'end'`, so it double-fires;
`process.exit` on the first preempts the second today, but any future async cleanup (flush,
socket end-wait) makes idempotency load-bearing.

**(d) Correct the false comment at `:149-150`.** The `timeoutMs === null` "wait forever" path is
only safe *because* of (a)/(b); the current justification is false and would reintroduce the
bug. A correctness dependency, not a docs nicety.

**Not doing:** `process.on('disconnect')` — fires only for children spawned with a Node IPC
channel; both paths use plain pipes. **[rev1 error]** proposed it as "belt-and-braces"; dead code.

### Regression surface

If any spawn path hands the server `/dev/null` stdin, (b) fires instantly at startup →
`exit(0)` → and `handleExit` (`mcpServerLifecycle.ts:224-226`) treats even a code-0 exit as
restart-worthy → 2-restart churn ending in `'failed'`. Both current paths use pipes
(`stdio: ['pipe','pipe','pipe']`, `mcpServerLifecycle.ts:131`), so this is latent, but the claim
is scoped to "no regression **given piped stdin**" and asserted by test.

**[rev2 error]** Rev 2's risk table said a spurious stdin fire is mitigated because "the ppid
backstop is independent". That is not a mitigation — an over-eager stdin handler exiting a live
server *is* the failure. The only real mitigation is the stays-alive test (§8).

## 6. Phase 2 — the `ELECTRON_RUN_AS_NODE` guard omission (separate bug, TWO paths)

Independent of the leak. `McpServerLifecycle._spawn()` composes the guard
(`mcpServerLifecycle.ts:120-128`):

```ts
// CRITICAL fork-bomb guard: findNodeExecutable() may resolve to the Electron
// app binary (packaged app, no node on PATH) — spawning it plainly boots a
// whole new Cyboflow app in an unkillable loop.
...electronRunAsNodeGuardEnv(nodePath)
```

**Two production paths resolve the same interpreter via the same `findNodeExecutable()` and
omit the guard:**

| Path | Site | env supplied |
|---|---|---|
| SDK substrate | `claudeCodeManager.ts:3018-3041` | `CYBOFLOW_RUN_ID`, `CYBOFLOW_ORCH_SOCKET`, optional `CYBOFLOW_MCP_SCOPE` |
| **Interactive/PTY substrate** | `interactiveClaudeManager.ts:778-808` (`writeInteractiveMcpConfig`, wired via `spawnCliProcess` at `:1111`) | `CYBOFLOW_RUN_ID`, `CYBOFLOW_ORCH_SOCKET` |

**[rev2 error]** Rev 2 named only the SDK path. Fixing one substrate leaves the identical
fork-bomb live in the other.

**Coverage is now closed.** An exhaustive round-3 audit found **five** sites that spawn or
configure a `cyboflowMcpServer`, and exactly the two above are unguarded:

| Site | Guard |
|---|---|
| `mcpServerLifecycle.ts:127` (singleton) | ✅ |
| `claudeCodeManager.ts:3018-3041` (SDK) | ❌ — Phase 2 |
| `interactiveClaudeManager.ts:791-808` (PTY) | ❌ — Phase 2 |
| `codex/appServer/runConfig.ts` (Codex app-server) | ✅ *(verified directly)* |
| `mcpConfigWriter.ts:61` (legacy `.mcp.json`) | ✅ |

No third unguarded path exists.

Fix: add `...electronRunAsNodeGuardEnv(nodeCmd)` at **both** sites. `electronNodeGuard.ts:21`
gates on `nodeExecutablePath === process.execPath`, so it is a no-op with a real node path.

### Why this has not fired yet — third attempt, this time verified

**[rev2 error]** Rev 2 said the omission is masked by inheritance "from the Electron main
process". Impossible: if the main process's env carried `ELECTRON_RUN_AS_NODE=1`, the app would
have booted as node.

**[rev3 error]** Rev 3 over-corrected. It claimed the flag enters on the `claude` spawn
"(`AbstractCliManager.ts:820-824`; the SDK's execPath spawn likewise)" and is inherited by the
MCP child. Both halves are wrong. Verified:

- `AbstractCliManager.ts:818-825` sets the flag **only** on the execPath branch
  (`nodePath === process.execPath ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env`), and only
  inside the "spawn with Node.js directly" fallback. A PTY spawn of the `claude` binary itself
  never sets it.
- **The SDK does not spawn an interpreter via execPath.** cyboflow points it at the packaged
  `claude` binary via `pathToClaudeCodeExecutable` (`claudeCodeManager.ts:2813`), and
  `ELECTRON_RUN_AS_NODE` appears nowhere in `@anthropic-ai/claude-agent-sdk@0.3.224`.

  **[rev4 error] — a "verified" absolute that a grep refutes.** Rev 4 stated the SDK "contains
  zero occurrences of either `ELECTRON_RUN_AS_NODE` or `process.execPath`". The second half is
  false: `bridge.mjs` carries six `execPath` references. They survived my grep only because the
  bundle is minified, so they read `$f.execPath` / `og.execPath` rather than the literal
  `process.execPath` I searched for — a literal-string grep cannot establish absence in minified
  code. They are execa's `preferLocal` PATH-priming machinery, not an interpreter spawn, so the
  conclusion above is unchanged; the *claim* was still stated more absolutely than the evidence
  supported. Fourth instance of this document's recurring error.

So there is **no inherited mask on the SDK substrate**, and only a narrow branch-local one on
PTY. The omission is latent for a simpler reason: `findNodeExecutable()` reaches its
`process.execPath` fallback only in a packaged app with no `node` on `PATH`, which is
uncommon — but it is exactly the shipped-user configuration, and nothing else stands between it
and an unkillable Electron boot loop. Urgency unchanged; the mechanism is now the real one.

## 7. Phase 3 — verification channel (NEW in rev 3, non-optional)

**[rev2 error] — rev 2 shipped a fix with no way to know it worked.** Rev 2's risk table claimed
recurrence stays visible because the exit path logs to stderr, "which `McpServerLifecycle` routes
to the app logger (`mcpServerLifecycle.ts:139-146`)". That routing exists **only for the
singleton**. The population that actually leaks is CLI-spawned per-session servers whose stderr
is piped to the now-dead `claude` — the log goes into a broken pipe and is never seen. Rev 2
simultaneously removed the external reaper and recommended no sweep, leaving zero observation.

**Build an observe-only tripwire.** `ps`-scan for the `cyboflowMcpServer.js` marker with
`ppid === 1` under this install's resolved script path, and **log the count. Kill nothing.**

- No kill authority ⇒ no PID-reuse race, no scope-guard risk, no possibility of killing a live
  server. The whole class of objections to rev 1's reaper evaporates.
- A non-zero count post-fix means Phase 1 is not working (handler misplaced, stdin paused,
  ppid timer not firing) — the single signal that the fix is real.
- Mirrors the `CodexBrokerReaper` harness (`ps -axo …`, substring marker match, fail-soft), so
  it is cheap. It does **not** reuse `parsePsOutput` verbatim: that parser is 3-column and this
  scan needs a 4th (`etime`, below). Widening the shared parser would change the broker reaper's
  behavior for no benefit, so the tripwire carries its own 4-column parser.

**[rev3 error] — a boot-only tripwire is a null verification channel.** Rev 3 specified this
scan as boot-only. Both round-3 reviewers independently caught that this cannot observe the leak
it exists to verify: §12 establishes that every orphan dies at app exit, and §1 shows
accumulation is strictly mid-uptime (40 orphans aged 2h29m–2d20h inside a single 3d21h uptime,
no cross-boot residue). A boot scan therefore reads ~zero forever, whether Phase 1 works or not.
On the very host that produced this bug it would have counted 0 at every boot while 40 orphans
accumulated. Rev 3 removed the external reaper *and* scheduled its replacement signal at the one
moment the signal is guaranteed absent — reproducing rev 2's "no way to know it worked" defect
in observability costume.

**The scan is periodic.** An `unref()`'d hourly interval plus one boot scan. It kills nothing,
so every safety objection to periodic scanning is inapplicable; the cost is one `ps` per hour.

**A grace window is required, not optional.** A periodic scan can sample an orphan during the
≤60 s window in which Phase 1's watchdog is legitimately about to kill it, producing a false
alarm that would discredit the only signal we have.

**[rev4 error] — the age gate measured the wrong quantity.** Rev 4 specified this as "count a
process only once its `etime` exceeds twice the watchdog interval". Codex caught it in round 4:
`etime` is a process's **total lifetime**, not how long it has been orphaned. A server that ran
healthily for three hours and lost its spawner one second before a scan has an `etime` of three
hours, clears any age threshold instantly, and is counted — *precisely* the false alarm the gate
was introduced to prevent. The gate excluded nothing except short-lived servers, which are not
the population at risk.

What actually separates the two cases is **duration spent orphaned**, which no single `ps` row
carries. So the implementation requires a process to be observed at `ppid === 1` on **two scans
at least 120 s apart**. A watchdog-doomed orphan dies within ~60 s and never reaches the second
sighting; a genuine leak persists forever and always does. `etime` is still read, but only to
derive a start time that identifies a process across scans (guarding against PID reuse). A
confirmation rescan is armed when a first sighting appears, so a boot-stranded orphan surfaces
in minutes rather than at the next hourly tick.

This is the **third** time in this document that a verification mechanism turned out not to
measure what it claimed — after rev 2's unobservable stderr and rev 3's boot-only scan. The
recurring error is asserting that a signal exists without tracing the path it travels.

*Verified:* macOS `ps` supports `etime` (`[[dd-]hh:]mm:ss`) but **not** `etimes`. An unknown
keyword makes `ps` print `ps: etimes: keyword not found` to stderr, **still exit 0, and silently
emit the remaining columns** — so a parser that assumed a column it never got would mis-index
every row while looking healthy. Use `etime` and parse the three shapes.

If a count is ever non-zero in the field, promote it to an actual sweep — but only then, and
with evidence.

## 8. Phase 4 — cleaning up already-leaked orphans

Servers from pre-fix builds leak until the user updates.

**[rev2 error] — "by definition" was an overclaim.** Rev 2 argued every pre-fix orphan dies at
the update restart "by definition". Three cracks:

1. **Per-instance tethering.** cyboflow runs stable and dev instances with per-kind data dirs
   and per-kind orch sockets. An orphan is tethered to *its own instance's* socket, so
   restarting stable does not reap dev-tethered orphans.
2. It assumes every deployed build carries line 132 — verified only for current source.
3. Staged Electron updates apply at the *eventual* quit; on a 3d21h-uptime host the old build
   keeps minting orphans for days after ship.

The honest bound: **orphans persist until their own instance's next quit.**

Recommendation: still do nothing active. The §7 tripwire will report the real number, and a
one-shot boot sweep can be promoted from it if that number is non-zero. This is now an
evidence-gated decision rather than an assumption.

### Rejected alternatives

| Alternative | Why rejected |
|---|---|
| **Periodic external `ps` reaper** (rev 1's core) | Needs PID-reuse mitigation, scope guards, and kill authority to infer what the server knows for free. At 288 sweeps/day the `CodexBrokerReaper` precedent (boot + worktree-removal only) does not transfer. |
| **Socket-side closure via `LOCAL_PEERPID`** | Safer than `ps`, but `orchSocketServer.ts:83` tracks connections as a bare `Set<net.Socket>` with no peer identity or handshake, and Node's `net` does not expose `LOCAL_PEERPID` — needs native bindings or a new protocol message. Self-termination gets the same safety in a few lines. |
| **Age/idle threshold** | No idle signal exists, and `ppid === 1` is decisive without one. |

## 9. Tests

**Phase 1 — the root-cause fix (rev 1 had NO tests here):**

- Subprocess lifecycle: spawn the built `cyboflowMcpServer.js` with piped stdin and a fake orch
  socket, close stdin, assert `exit(0)` within a bounded timeout.
- **Startup-window case:** spawn and kill the parent *immediately*, before the server finishes
  `server.connect()` — asserts the module-scope installation requirement in §5(b).
- Assert the server does **not** exit while stdin stays open (guards §5's regression surface).
- ppid watchdog against an injected `getPpid` seam: exits on `1`, not otherwise; timer is
  `unref`'d and does not hold the loop open.
- `shutdown()` is idempotent under double-fire (`'end'` then `'close'`).

**Phase 2 — both paths:**

- `composeMcpServers` with `findNodeExecutable()` → `process.execPath` asserts
  `ELECTRON_RUN_AS_NODE=1`; with a real node path asserts env unchanged.
- **The same two cases for `writeInteractiveMcpConfig`** (assert against the written config file).

**Phase 3:** tripwire counts a `ppid === 1` marker match under this install's script path; does
**not** count `ppid !== 1`; does not count out-of-install paths; **does not count a match younger
than the age gate** (the false-alarm case that makes the signal sound); **kills nothing** — the
class exposes no killer seam at all, so "kills nothing" is a type-level property rather than an
assertion about an untaken branch; `etime` parses all three macOS shapes (`mm:ss`, `hh:mm:ss`,
`dd-hh:mm:ss`); fail-soft on `ps` failure; the interval is `unref`'d and `stop()` clears it.

## 10. Risks

| Risk | Mitigation |
|---|---|
| `/dev/null` stdin → instant exit → restart churn | Both current paths use pipes; asserted by test; claim scoped to piped stdin |
| stdin EOF fires spuriously mid-session | Stays-alive test (§9). No in-protocol spurious class exists: MCP stdio shutdown *is* stdin close, and nothing here pauses/destroys stdin today |
| ppid watchdog kills a live server | Impossible on macOS while the spawner lives (§5a). Only counterexample class is an intermediate wrapper exiting while holding the pipe open — not present (both paths spawn directly, no `shell: true`, no `detached`) |
| Fix silently fails | §7 tripwire — the only verification channel |
| A future non-stdio (HTTP/SSE) transport | Invalidates the stdin premise; ppid watchdog still holds. Note in docstring |

## 11. Load-bearing invariant to pin

**[rev1 error]** Rev 1 asserted a dead-parent server is "unreachable by construction because its
only channel is the pipe". False: these servers also hold a live orch socket
(`cyboflowMcpServer.ts:96-135`) and send on it (`sendQuery`, `:137`).

Correct, narrower statement: **MCP requests arrive only via stdin; the orch socket carries only
server-initiated request/reply traffic.** True today, but contingent — the moment anyone adds
orchestrator-**pushed** traffic (cancellation, config reload, a question-gate answer path), a
dead-parent server stops being provably useless. Pin this in the docstring at the exit handler,
and assert in a test that the socket protocol defines no unsolicited-push message type.

## 12. Correction to §2's exit-at-quit mechanism

**[rev2 error]** Rev 2 said app quit closes "the listening socket's fds", so orphans self-exit.
Closing a *listening* socket does **not** disconnect established connections — accepted
per-connection fds are separate.

What actually happens (conclusion unchanged, mechanism corrected):

- **SIGKILL / crash / force-quit:** the kernel closes *all* fds at process termination,
  including accepted per-connection fds. Orphan clients see EOF → line 132 exits.
- **Graceful quit:** identical mechanism. `OrchSocketServer.stop()` does destroy every tracked
  connection (`orchSocketServer.ts:249-252`), but **[rev3 error]** rev 3 cited it as the graceful
  path's mechanism without checking whether it runs. It has **no production call site** —
  `index.ts` calls only `start()`, `getSocketPath()`, `cancelInFlightShellApprovals()`, and
  `isSocketPathIntact()`. So in every real exit it is process termination closing the fds, and
  rev 3 committed the exact defect it faults rev 2 for in §3: citing an uncalled method as
  runtime behavior.

No exit path leaves an orphan connected — but it is the **connection** fds doing the work, never
the listener's, and it is *termination* doing it, never `stop()`. Anyone implementing a partial
shutdown ("close the listener to drain") would be misled by the rev 2 wording into believing
orphans die when they would not.

## 13. Open questions

1. ~~Should the §7 tripwire fire periodically rather than boot-only?~~ **Resolved in rev 4:
   yes, and it was not optional** — boot-only made the signal structurally unobservable (§7).
   Hourly, `unref`'d, age-gated.
2. Is 60 s the right ppid-watchdog interval, given stdin EOF should almost always win the race?
   *(Rev 4 keeps 60 s; the tripwire's age gate is defined as 2× this, so the two move together.)*
3. Is fixing the `:149-150` "wait forever" comment enough, or should that path get a real
   ceiling regardless? **Still open — deliberately out of scope here.** Phase 1 makes the
   existing comment true, so the unbounded wait is no longer unsound; giving it a ceiling is a
   separate behavioral change that would alter tool-call semantics.
4. Does anything else in the codebase depend on an MCP server outliving its spawner? *(§11's
   invariant is the pin; no such dependency found.)*
