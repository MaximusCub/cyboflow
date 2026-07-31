/**
 * secrets — the app's first app-owned secret storage seam, for tracker-sync
 * provider API keys. Design: docs/proposals/tracker-sync-integration.md
 * ("Auth & secrets").
 *
 * No prior pattern for app-owned third-party secrets exists in this codebase
 * (no keytar/safeStorage usage before this). This module wraps Electron's
 * `safeStorage` (OS keychain-backed on macOS/Windows; libsecret on Linux) so
 * the encrypt/decrypt call sites stay a single, testable seam:
 *   - Plaintext keys never touch sqlite; only the encrypted Buffer does
 *     (stored in `tracker_connections.secret_ciphertext`).
 *   - Decryption happens ONLY in the main process — the renderer sees
 *     connection status, never the key (see the proposal's "Keys never cross
 *     the IPC boundary").
 *
 * Dependency-free beyond `electron` by design, so it can be unit-tested with
 * a mocked `electron` module (no sqlite, no network).
 */

import { safeStorage } from 'electron';

/**
 * Thrown when the OS-level encryption backend is unavailable
 * (`safeStorage.isEncryptionAvailable()` is false — e.g. no keychain access
 * on the host). Callers should surface this as a connect-time failure rather
 * than falling back to storing plaintext.
 */
export class TrackerSecretsUnavailableError extends Error {
  constructor(message = 'OS-level secret encryption is not available on this machine') {
    super(message);
    this.name = 'TrackerSecretsUnavailableError';
  }
}

/**
 * Encrypt a plaintext secret (a tracker provider API key) for storage in
 * `tracker_connections.secret_ciphertext`.
 *
 * @throws {TrackerSecretsUnavailableError} when the OS backend cannot
 *   encrypt on this machine.
 */
export function encryptTrackerSecret(plain: string): Buffer {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new TrackerSecretsUnavailableError();
  }
  return safeStorage.encryptString(plain);
}

/**
 * Decrypt a ciphertext Buffer previously produced by `encryptTrackerSecret`.
 *
 * @throws {TrackerSecretsUnavailableError} when the OS backend cannot
 *   decrypt on this machine.
 */
export function decryptTrackerSecret(cipher: Buffer): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new TrackerSecretsUnavailableError();
  }
  return safeStorage.decryptString(cipher);
}
