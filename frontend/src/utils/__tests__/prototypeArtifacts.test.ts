/**
 * prototypeArtifacts tests — focused coverage of `hideSupersededPrototypes`
 * (the center-pane tab-hiding rule this suite exists for), plus minimal
 * coverage of `prototypeHasBytes` and `pickPrototype` since they live in the
 * same module and back the same bytes/tier precedence.
 */
import { describe, it, expect } from 'vitest';
import type { Artifact } from '../../../../shared/types/artifacts';
import { hideSupersededPrototypes, prototypeHasBytes, pickPrototype } from '../prototypeArtifacts';

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'art-1',
    runId: 'run-1',
    sessionId: 'sess-1',
    atype: 'ui-prototype',
    label: 'Prototype',
    stepOrigin: null,
    mode: 'canvas',
    committed: false,
    sessionOnly: true,
    isNew: false,
    payloadJson: JSON.stringify({ fileName: 'prototype/index.html' }),
    sourceRef: null,
    createdAt: '2026-07-23T00:00:00Z',
    committedAt: null,
    ...overrides,
  } as Artifact;
}

describe('prototypeHasBytes', () => {
  it('is false for a null artifact', () => {
    expect(prototypeHasBytes(null)).toBe(false);
  });

  it('is false for a bytes-less stub (payloadJson null)', () => {
    expect(prototypeHasBytes(makeArtifact({ payloadJson: null }))).toBe(false);
  });

  it('is false for unparseable payloadJson', () => {
    expect(prototypeHasBytes(makeArtifact({ payloadJson: 'not json' }))).toBe(false);
  });

  it('is false when payload has no string fileName', () => {
    expect(prototypeHasBytes(makeArtifact({ payloadJson: JSON.stringify({ url: 'x' }) }))).toBe(false);
  });

  it('is true when payload carries a string fileName', () => {
    expect(
      prototypeHasBytes(makeArtifact({ payloadJson: JSON.stringify({ fileName: 'prototype/index.html' }) })),
    ).toBe(true);
  });
});

describe('pickPrototype', () => {
  it('prefers a payload-bearing interactive-prototype over a bytes-less ui-prototype stub', () => {
    const stub = makeArtifact({ id: 'a-stub', atype: 'ui-prototype', payloadJson: null });
    const live = makeArtifact({ id: 'a-live', atype: 'interactive-prototype' });
    expect(pickPrototype([stub, live])?.id).toBe('a-live');
    expect(pickPrototype([live, stub])?.id).toBe('a-live');
  });

  it('returns null when no prototype-family artifact is present', () => {
    expect(pickPrototype([makeArtifact({ atype: 'generic' })])).toBeNull();
  });
});

describe('hideSupersededPrototypes', () => {
  it('drops a bytes-less ui-prototype stub when a payload-bearing interactive-prototype is present', () => {
    const stub = makeArtifact({ id: 'a-stub', atype: 'ui-prototype', payloadJson: null });
    const live = makeArtifact({ id: 'a-live', atype: 'interactive-prototype' });
    const result = hideSupersededPrototypes([stub, live]);
    expect(result).toEqual([live]);
  });

  it('drops a payload-bearing ui-prototype (post-promotion) when a payload-bearing interactive-prototype is present', () => {
    const staticProto = makeArtifact({ id: 'a-static', atype: 'ui-prototype' });
    const live = makeArtifact({ id: 'a-live', atype: 'interactive-prototype' });
    const result = hideSupersededPrototypes([staticProto, live]);
    expect(result).toEqual([live]);
  });

  it('leaves a ui-prototype (bytes-less or not) unchanged when no interactive-prototype is present', () => {
    const stub = makeArtifact({ id: 'a-stub', atype: 'ui-prototype', payloadJson: null });
    const proto = makeArtifact({ id: 'a-proto', atype: 'ui-prototype' });
    expect(hideSupersededPrototypes([stub])).toEqual([stub]);
    expect(hideSupersededPrototypes([proto])).toEqual([proto]);
  });

  it('leaves the list unchanged when the only interactive-prototype is bytes-less (no live interactive yet)', () => {
    const proto = makeArtifact({ id: 'a-proto', atype: 'ui-prototype' });
    const notYetLive = makeArtifact({ id: 'a-stub-interactive', atype: 'interactive-prototype', payloadJson: null });
    const result = hideSupersededPrototypes([proto, notYetLive]);
    expect(result).toEqual([proto, notYetLive]);
  });

  it('passes non-prototype atypes through untouched regardless of interactive-prototype presence', () => {
    const idea = makeArtifact({ id: 'a-idea', atype: 'idea-spec', payloadJson: null });
    const stub = makeArtifact({ id: 'a-stub', atype: 'ui-prototype', payloadJson: null });
    const live = makeArtifact({ id: 'a-live', atype: 'interactive-prototype' });
    const result = hideSupersededPrototypes([idea, stub, live]);
    expect(result).toEqual([idea, live]);
  });
});
