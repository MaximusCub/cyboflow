/**
 * dependencyCommandGuard — the ONE place the "a verification may not mutate
 * dependencies" rule is spelled out (docs/proposals/verification-setup-flow.md
 * §7.2 "Snapshot dep isolation — a specified preparer, runner-enforced", plus
 * §5.3's "Dependency mutation is runner-enforced, not linted").
 *
 * THE HAZARD, CONCRETELY. `snapshotProvisioner.linkDependencyDirs` SYMLINKS
 * `node_modules` from the live sprint worktree into the detached verification
 * snapshot. A snapshot is therefore NOT dependency-isolated: any `pnpm install`
 * / `npm rebuild` / `npx playwright install` a composed task runs inside it
 * writes THROUGH that symlink into the shared worktree every sibling lane is
 * building against. The classic outcome is §1's root cause (c) inverted — a
 * fresh install leaves better-sqlite3 on the host-Node ABI (NMV 127) while the
 * sibling lanes' Electron needs NMV 136 — and the damage is INVISIBLE to the
 * runner's own guard rails: `checkSnapshotMutated` runs `git diff HEAD`, which
 * sees tracked files only and `node_modules` is not tracked. A whole sprint can
 * be poisoned by one verification's build step with nothing in the verdict
 * hinting at it.
 *
 * WHY A REGEX AND NOT A LINT. §5.3's v2 correction has teeth: build steps reach
 * the runner from TWO sources — a committed runbook's
 * `VerifyRunbookModalityEntry.build` and an AGENT-composed
 * `VerificationTaskV1.build` (task-verify's own exemplar recommended
 * `pnpm install` until this phase changed it). A validator on the runbook file
 * cannot reach the second source at all, so the guard has to sit on the
 * COMPOSED TASK, where both converge. It is applied at two seams:
 *
 *   - ENQUEUE (this phase, verify/enqueueFromTask.ts): a matching task is
 *     REJECTED before a row is ever written, so the composing agent gets a
 *     structured error naming the offending command while it still has the
 *     context to recompose. This is the cheap half.
 *   - EXECUTION (the sibling agent-session Bash guard + the dependency
 *     preparer): the backstop for anything that reaches a shell anyway.
 *
 * Both consume the SAME {@link FORBIDDEN_DEP_COMMAND_PATTERN}. That is the whole
 * point of this module existing rather than each seam carrying its own copy: a
 * pattern that is widened in one place and not the other is a guard that
 * silently stops covering the case someone just discovered.
 *
 * CONSERVATIVE BY DESIGN, IN THE SAFE DIRECTION. A false positive costs the
 * composer one recomposition with an explicit reason. A false negative costs a
 * cross-lane ABI flip that presents as unrelated lanes failing to build. So the
 * pattern matches ANYWHERE in a shell string — after `&&`, after `;`, inside a
 * `sh -c "..."` — rather than only at the start, and it is case-insensitive.
 * What it deliberately does NOT do is guess: it matches package-manager
 * DEPENDENCY VERBS, never a script invocation (`pnpm run build`, `pnpm dev`,
 * `pnpm test:unit` are all fine — running a project's own scripts is the entire
 * job of a build step).
 *
 * Standalone-typecheck invariant (mirrors capabilityStore.ts / runbookHash.ts):
 * imports ONE shared type and nothing else — no node, no electron, no
 * better-sqlite3, no services/*.
 */
import type { VerificationTaskV1 } from '../../../../shared/types/visualVerification';

/**
 * The §7.2 forbidden-command pattern — the SINGLE SOURCE OF TRUTH for both the
 * enqueue-time rejection and the execution-time guard. Widen it HERE and both
 * seams widen together.
 *
 * Four families, each anchored on word boundaries so a substring can never
 * trigger it:
 *
 *  1. `(pnpm|npm|yarn|bun) <dependency verb>` — install / i / ci / add /
 *     rebuild / up / update / upgrade. Intervening FLAG tokens are tolerated
 *     (`pnpm -r install`, `npm --prefix x ci`) but non-flag tokens are NOT, and
 *     that asymmetry is deliberate: allowing arbitrary tokens between the
 *     manager and the verb would make `pnpm run install` — a project script
 *     that happens to be named "install" — indistinguishable from a real
 *     install, and scripts are exactly what a build step is supposed to run.
 *  2. `playwright install` — the browser-binary download. Matched
 *     runner-agnostically (`npx playwright install`, `pnpm exec playwright
 *     install`, a bare `playwright install`) because the hazard is the download
 *     writing into the shared dependency tree, not which launcher spelled it.
 *  3. `electron-rebuild` — the native-module ABI flip in its most direct form.
 *  4. `electron-builder install-app-deps` — the same flip wearing the packaging
 *     tool's name. Both belong to the §7.2 dependency PREPARER (keyed by
 *     lockfile hash / platform / arch / node major / electron ABI / browser
 *     build, built outside any snapshot), never to a task's build step.
 */
export const FORBIDDEN_DEP_COMMAND_PATTERN = new RegExp(
  [
    // (1) package-manager dependency mutation, with optional intervening flags.
    String.raw`\b(?:pnpm|npm|yarn|bun)(?:\s+-{1,2}[^\s]+)*\s+(?:install|i|ci|add|rebuild|up|update|upgrade)\b`,
    // (2) browser-binary download, whatever the launcher.
    String.raw`\bplaywright\s+install\b`,
    // (3) + (4) electron native-ABI rebuilds.
    String.raw`\belectron-rebuild\b`,
    String.raw`\belectron-builder\s+install-app-deps\b`,
  ].join('|'),
  'i',
);

/**
 * Every command in a composed task that mutates dependencies, returned VERBATIM
 * (the full offending shell string, not the matched fragment) so the caller's
 * error names exactly what the composer wrote and the composer can find it
 * without re-deriving anything.
 *
 * Covers both command channels a task carries: every `build[]` entry, in order,
 * then `serve.cmd`. Order is the task's own, so a multi-offender task reads
 * top-to-bottom the way it was composed. Duplicates are preserved for the same
 * reason — "you wrote it twice" is information.
 *
 * Note that this checks the COMPOSED task, which by the time the enqueue seam
 * calls it may already carry a proven runbook's merged build/serve (§5.2 seam
 * 3). That is intended: §7.2's rule is "rejected in EVERY composed task's
 * build/serve steps — runbook-sourced and agent-composed alike", and a runbook
 * that smuggles an install through the merge is exactly as dangerous as an
 * agent that guessed one.
 */
export function findForbiddenTaskCommands(task: VerificationTaskV1): string[] {
  const offenders: string[] = [];
  for (const step of task.build ?? []) {
    if (typeof step === 'string' && FORBIDDEN_DEP_COMMAND_PATTERN.test(step)) offenders.push(step);
  }
  const serveCmd = task.serve?.cmd;
  if (typeof serveCmd === 'string' && FORBIDDEN_DEP_COMMAND_PATTERN.test(serveCmd)) {
    offenders.push(serveCmd);
  }
  return offenders;
}
