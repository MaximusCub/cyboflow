/**
 * trackerVocabulary — the two provider facts that are not self-evident from
 * reading the table.
 *
 * `needsApiKey` is a DUPLICATE of a main-side answer by necessity (the wizard
 * bundle must not import main/src/services/*), and the two halves disagreeing
 * is not a cosmetic bug: a provider the catalog calls keyless and the service
 * calls keyed renders a Detect button whose probe the router rejects, with no
 * field to fix it in. So the parity is asserted rather than assumed.
 *
 * The detect-failure classifier is message matching — both failures cross IPC
 * as the same error class with a null status, so there is nothing structural
 * left to branch on (see its own comment). Its inputs here are the VERBATIM
 * strings `main/src/services/trackerSync/beadsAdapter.ts` emits.
 */
import { describe, expect, it } from 'vitest';
import {
  BEADS_INIT_DISCLOSURE,
  TRACKER_PROVIDERS,
  classifyKeylessDetectFailure,
} from './trackerVocabulary';
import { providerNeedsSecret } from '../../../../../shared/types/trackerSync';

describe('trackerVocabulary — needsApiKey parity', () => {
  it('agrees with the main-side providerNeedsSecret for every provider', () => {
    expect(TRACKER_PROVIDERS.length).toBeGreaterThan(0);
    for (const meta of TRACKER_PROVIDERS) {
      expect([meta.provider, meta.needsApiKey]).toEqual([
        meta.provider,
        providerNeedsSecret(meta.provider),
      ]);
    }
  });

  it('has exactly one keyless provider today — beads', () => {
    expect(TRACKER_PROVIDERS.filter((meta) => !meta.needsApiKey).map((m) => m.provider)).toEqual([
      'beads',
    ]);
  });
});

describe('classifyKeylessDetectFailure', () => {
  it('reads a missing `bd` binary out of the ENOENT arm’s message', () => {
    expect(
      classifyKeylessDetectFailure(
        '[beads] `bd` was not found on PATH — install beads (github.com/gastownhall/beads) and ' +
          're-detect this connection.',
      ),
    ).toBe('missing-cli');
  });

  it('reads an uninitialized repo out of both ways beads reports one', () => {
    // bd's own stderr marker, surfaced through TERMINAL_STDERR_MARKERS…
    expect(classifyKeylessDetectFailure('[beads] Error: no beads database found')).toBe(
      'missing-workspace',
    );
    // …and probeWorkspace's own message when `bd where` answers without a path.
    expect(
      classifyKeylessDetectFailure(
        '[beads] `bd where` did not report a workspace path and prefix — this project has no ' +
          'resolvable beads workspace. Run `bd init` in it, then re-detect.',
      ),
    ).toBe('missing-workspace');
  });

  it('falls back to unknown rather than guessing, so the copy stays the server’s own', () => {
    expect(
      classifyKeylessDetectFailure(
        '[beads] beads 1.1.0 is older than the minimum supported 1.2.2',
      ),
    ).toBe('unknown');
    expect(classifyKeylessDetectFailure('')).toBe('unknown');
  });
});

describe('BEADS_INIT_DISCLOSURE', () => {
  it('names both probed side effects a user has to decide about before running `bd init`', () => {
    const copy = BEADS_INIT_DISCLOSURE.join(' ');
    // The repo write, and the flag that avoids it.
    expect(copy).toContain('bd init --stealth');
    expect(copy).toContain('18 files');
    expect(copy).toContain('.claude/settings.json');
    // The telemetry default, and the command that turns it off.
    expect(copy).toContain('bd metrics off');
  });
});
