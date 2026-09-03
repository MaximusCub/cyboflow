import { describe, it, expect, beforeEach } from 'vitest';
import { readDismissals, recordDismissal } from '../recommendedActionDismissals';

const STORAGE_KEY = 'cyboflow.reviewQueue.dismissedActions.v1';

describe('recommendedActionDismissals', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns {} when nothing has been persisted', () => {
    expect(readDismissals()).toEqual({});
  });

  it('round-trips a single dismissal', () => {
    recordDismissal('merge-clean', 'sig-a');
    expect(readDismissals()).toEqual({ 'merge-clean': 'sig-a' });
  });

  it('merges multiple dismissals under distinct ids', () => {
    recordDismissal('merge-clean', 'sig-a');
    recordDismissal('rebase-behind', 'sig-b');
    expect(readDismissals()).toEqual({ 'merge-clean': 'sig-a', 'rebase-behind': 'sig-b' });
  });

  it('overwrites the signature for the same id', () => {
    recordDismissal('merge-clean', 'sig-a');
    recordDismissal('merge-clean', 'sig-b');
    expect(readDismissals()).toEqual({ 'merge-clean': 'sig-b' });
  });

  it('tolerates corrupt JSON in storage by returning {}', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    expect(readDismissals()).toEqual({});
  });

  it('tolerates a non-object JSON value in storage by returning {}', () => {
    localStorage.setItem(STORAGE_KEY, '"just a string"');
    expect(readDismissals()).toEqual({});
  });

  it('tolerates an array JSON value in storage by returning {}', () => {
    localStorage.setItem(STORAGE_KEY, '["a", "b"]');
    expect(readDismissals()).toEqual({});
  });

  it('tolerates a map with non-string values by returning {}', () => {
    localStorage.setItem(STORAGE_KEY, '{"merge-clean": 123}');
    expect(readDismissals()).toEqual({});
  });

  it('recordDismissal never throws even if it cannot persist', () => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('quota exceeded');
    };
    try {
      expect(() => recordDismissal('merge-clean', 'sig-a')).not.toThrow();
    } finally {
      Storage.prototype.setItem = originalSetItem;
    }
  });
});
