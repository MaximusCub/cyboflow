/**
 * Unit tests for the tracker-sync secrets seam (main/src/services/trackerSync/
 * secrets.ts) — the app's first app-owned secret storage, wrapping Electron
 * `safeStorage`.
 *
 * The global test setup (main/src/test/setup.ts) mocks the `electron` module
 * but does not include `safeStorage`. This file overrides the `electron` mock
 * via `vi.mock` (hoisted before imports, per the dockBadgeService.test.ts
 * pattern) so `safeStorage.{isEncryptionAvailable,encryptString,decryptString}`
 * are available when `secrets.ts` is imported.
 *
 * Covers:
 *   1. Round-trip: encryptTrackerSecret -> decryptTrackerSecret returns the
 *      original plaintext, via safeStorage (not a real OS keychain — the mock
 *      below implements it with a trivial reversible transform).
 *   2. Unavailable-backend path: isEncryptionAvailable() === false throws
 *      TrackerSecretsUnavailableError from BOTH encrypt and decrypt, and
 *      neither call reaches encryptString/decryptString.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted: variables defined here are available inside vi.mock factories
// because Vitest hoists both vi.hoisted() calls and vi.mock() calls to the
// top of the module before any other code runs.
// ---------------------------------------------------------------------------
const { mockIsEncryptionAvailable, mockEncryptString, mockDecryptString } = vi.hoisted(() => ({
  mockIsEncryptionAvailable: vi.fn(() => true),
  // Trivial reversible "encryption" so the round-trip test can assert on real
  // bytes flowing through safeStorage without needing OS keychain access.
  mockEncryptString: vi.fn((plain: string) => Buffer.from(plain, 'utf-8')),
  mockDecryptString: vi.fn((cipher: Buffer) => cipher.toString('utf-8')),
}));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: mockIsEncryptionAvailable,
    encryptString: mockEncryptString,
    decryptString: mockDecryptString,
  },
}));

import {
  TrackerSecretsUnavailableError,
  encryptTrackerSecret,
  decryptTrackerSecret,
} from '../secrets';

describe('trackerSync secrets', () => {
  beforeEach(() => {
    mockIsEncryptionAvailable.mockReturnValue(true);
    mockEncryptString.mockClear();
    mockDecryptString.mockClear();
  });

  it('round-trips a plaintext secret through encrypt then decrypt', () => {
    const plain = 'lin_api_key_abc123';
    const cipher = encryptTrackerSecret(plain);
    expect(Buffer.isBuffer(cipher)).toBe(true);
    expect(mockEncryptString).toHaveBeenCalledWith(plain);

    const decrypted = decryptTrackerSecret(cipher);
    expect(decrypted).toBe(plain);
    expect(mockDecryptString).toHaveBeenCalledWith(cipher);
  });

  it('encryptTrackerSecret throws TrackerSecretsUnavailableError when the OS backend is unavailable', () => {
    mockIsEncryptionAvailable.mockReturnValue(false);
    expect(() => encryptTrackerSecret('plain')).toThrow(TrackerSecretsUnavailableError);
    expect(mockEncryptString).not.toHaveBeenCalled();
  });

  it('decryptTrackerSecret throws TrackerSecretsUnavailableError when the OS backend is unavailable', () => {
    mockIsEncryptionAvailable.mockReturnValue(false);
    expect(() => decryptTrackerSecret(Buffer.from('anything'))).toThrow(
      TrackerSecretsUnavailableError,
    );
    expect(mockDecryptString).not.toHaveBeenCalled();
  });
});
