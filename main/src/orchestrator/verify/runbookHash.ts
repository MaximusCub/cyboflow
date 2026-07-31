/**
 * runbookHash — the content-address of a portable verification runbook
 * (docs/proposals/verification-setup-flow.md §5.2 seam 3 + §5.3).
 *
 * WHY A HASH IS THE PIN. The verifier runs in a DETACHED SNAPSHOT at the task's
 * sha (`git worktree add --detach`), which makes the runbook unresolvable from
 * inside the snapshot in both directions: an uncommitted runbook is invisible
 * there, and a committed one is absent from every branch cut before it. v1 of
 * this proposal said "read it from the live worktree at compose time", which
 * breaks snapshot attribution the OTHER way — revision-B commands executing
 * against revision-A code produce a verdict attesting to a hybrid no revision
 * ever contained. v2's rule replaces both: the request row is stamped with the
 * portable half's CONTENT HASH (plus the machine-local record's CAS version) at
 * enqueue, the runner fetches exactly that revision by hash and executes it, and
 * ANY mismatch is a structured "runbook/sha mismatch" rejection — env-class,
 * non-attempt-charging — rather than an improvisation against live state.
 *
 * WHY CANONICALIZATION, SPECIFICALLY. The hash is the pin, and the pinned thing
 * is a file humans commit, review, and reformat. If the digest were taken over
 * raw bytes, then `prettier`, a trailing newline, a re-ordered key from an
 * editor's JSON sort, or a re-serialization by a future writer would each mint a
 * NEW runbook identity — invalidating every existing pin, demoting every proven
 * record, and forcing a re-proof for a change that altered nothing about how the
 * project is stood up. Two runbooks that are structurally equal must hash
 * equal; two that differ in any semantic field must not. Hence: recursive
 * key sort (objects are unordered by definition), array order PRESERVED (a build
 * step list is a sequence — reordering it is a real change), primitives via
 * `JSON.stringify`.
 *
 * This is deliberately the same canonicalization the agent-proposal CAS check
 * uses (`../agentThread/specHash.ts`), REUSED rather than re-implemented: two
 * subtly different "canonical JSON" implementations in one codebase is a bug
 * waiting for the day someone compares a hash across them. The thin wrappers
 * below exist to give the runbook seam its own named, typed entry points (and
 * its own doc-comment for WHY) without a second copy of the algorithm.
 *
 * Standalone-typecheck invariant (mirrors capabilityStore.ts): imports ONLY
 * node:crypto — transitively via specHash — plus the shared runbook type. No
 * electron, no better-sqlite3, no services/*.
 */
import { createHash } from 'node:crypto';
import type { VerifyRunbookV1 } from '../../../../shared/types/verifyRunbook';
import { canonicalJsonStringify } from '../agentThread/specHash';

/**
 * Deterministic serialization of a parsed runbook: object keys sorted
 * recursively at every depth, array order preserved.
 *
 * Takes the PARSED shape (not raw file text) on purpose —
 * `parseVerifyRunbookV1` rebuilds its result field-by-field, so unknown extra
 * keys tolerated on input never reach the digest. A future field's mere
 * presence in someone's file therefore cannot re-key a runbook that this
 * release's contract does not know about.
 */
export function canonicalRunbookJson(runbook: VerifyRunbookV1): string {
  return canonicalJsonStringify(runbook);
}

/**
 * The portable half's content hash — sha256 hex over
 * {@link canonicalRunbookJson}. This exact value is what
 * `verification_requests.runbook_hash` pins (migration 096), what
 * `verify_runbook_local.portable_hash` CAS-keys the machine-local record
 * against, and what `verify_capability_state.runbook_hash` (migration 095)
 * scopes the per-modality capability ledger by — one identity, three tables.
 */
export function runbookPortableHash(runbook: VerifyRunbookV1): string {
  return createHash('sha256').update(canonicalRunbookJson(runbook), 'utf8').digest('hex');
}
