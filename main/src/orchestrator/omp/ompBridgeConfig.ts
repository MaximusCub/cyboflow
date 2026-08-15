/**
 * Resolve the OMP bridge configuration for the privileged command adapter.
 *
 * The command path is deliberately fail-closed: unless every field resolves,
 * no adapter is built and the router returns `unavailable` (the Phase-2 stub
 * behaviour). A half-configured bridge must never silently authorize commands.
 *
 * Sources, in precedence order:
 * - `OMP_BRIDGE_URL` env, else the Prime bridge pointer file
 *   (`~/.prime/agent/omp-bridge.json`, field `url`) — loopback only.
 * - `OMP_BRIDGE_TOKEN_FILE` env (a 0600 file holding the raw bearer token);
 *   a raw bearer is required because the token is a minted credential, not a
 *   recoverable value.
 * - `OMP_BRIDGE_SESSION_ID` env (the OMP session whose tool host exposes the
 *   `fleet_*` tools).
 *
 * Standalone-typecheck invariant: node:fs only, no electron/services imports.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface OmpBridgeCommandConfig {
  readonly url: string;
  readonly token: string;
  readonly sessionId: string;
}

const DEFAULT_POINTER_PATH = join(homedir(), ".prime", "agent", "omp-bridge.json");

function readPointerUrl(pointerPath: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(pointerPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { url?: unknown };
    return typeof parsed.url === "string" && parsed.url.length > 0 ? parsed.url : undefined;
  } catch {
    return undefined;
  }
}

function resolveUrl(): string | undefined {
  const fromEnv = process.env.OMP_BRIDGE_URL;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return readPointerUrl(DEFAULT_POINTER_PATH);
}

function readTokenFile(tokenFile: string): string | undefined {
  if (!isAbsolute(tokenFile)) return undefined;
  let token: string;
  try {
    token = readFileSync(tokenFile, "utf8").trim();
  } catch {
    return undefined;
  }
  return token.length > 0 ? token : undefined;
}

/**
 * Resolve the bridge command config, or `undefined` when any required piece is
 * missing (or an env value is present but unusable). Callers treat `undefined`
 * as "no command adapter".
 */
export function resolveOmpBridgeCommandConfig(): OmpBridgeCommandConfig | undefined {
  const url = resolveUrl();
  if (url === undefined) return undefined;
  if (!url.startsWith("http://127.0.0.1") && !url.startsWith("http://localhost")) return undefined;

  const tokenFile = process.env.OMP_BRIDGE_TOKEN_FILE;
  if (tokenFile === undefined || tokenFile.length === 0) return undefined;
  const token = readTokenFile(tokenFile);
  if (token === undefined) return undefined;

  const sessionId = process.env.OMP_BRIDGE_SESSION_ID;
  if (sessionId === undefined || sessionId.length === 0 || sessionId.length > 256 || sessionId.includes("/")) {
    return undefined;
  }

  return { url, token, sessionId };
}
