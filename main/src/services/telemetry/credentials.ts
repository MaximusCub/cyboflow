/**
 * Telemetry credential + environment resolution.
 *
 * Extracted from ./index so that surfaces OTHER than `initTelemetry` can resolve
 * the same DSN without re-deriving the packaged-path logic. The in-app bug
 * reporter needs it: it must be able to send a report while passive error
 * reporting is switched off, which means constructing its own Sentry client from
 * the same credential, and a second hand-rolled copy of the asar-path lookup is
 * exactly how the "zero usage from installed apps" bug happened the first time.
 *
 * Nothing here may throw: every reader is defensive and falls back to undefined.
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { environmentFromBuildInfo, type TelemetryEnvironment } from './environment';

export interface BakedBuildInfo {
  environment?: unknown;
  sentryDsn?: unknown;
  aptabaseAppKey?: unknown;
}

/**
 * Read the packaged buildInfo.json — the source of the telemetry environment AND
 * the client credentials baked at build time. Returns null under `pnpm dev`
 * (unpackaged, no bundle) where creds come from process.env instead.
 *
 * With asar enabled (the electron-builder default) buildInfo.json lives INSIDE
 * app.asar — Electron patches fs to read archive member paths transparently — so
 * the resource path is `app.asar/...`, NOT a loose `app/` directory (which only
 * exists when asar is off). Reading the wrong one returns null and SILENTLY
 * disables telemetry. Try the asar path first, then the loose fallback.
 */
export function readBuildInfo(): BakedBuildInfo | null {
  if (!app.isPackaged) return null;
  const candidates = [
    path.join(process.resourcesPath, 'app.asar', 'main', 'dist', 'buildInfo.json'),
    path.join(process.resourcesPath, 'app', 'main', 'dist', 'buildInfo.json'),
  ];
  for (const buildInfoPath of candidates) {
    try {
      if (fs.existsSync(buildInfoPath)) {
        return JSON.parse(fs.readFileSync(buildInfoPath, 'utf8')) as BakedBuildInfo;
      }
    } catch {
      // Corrupt/unreadable candidate — fall through to the next, then null.
    }
  }
  return null;
}

/** Non-empty string or undefined (treats '' / non-strings as absent). */
export function asCred(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export interface TelemetryCredentials {
  sentryDsn: string | undefined;
  aptabaseAppKey: string | undefined;
  environment: TelemetryEnvironment;
}

/**
 * Resolve both client credentials plus the environment stamp.
 *
 * A runtime env var WINS (pnpm dev with .envrc.local loaded, or an explicit
 * override), otherwise fall back to the key BAKED into buildInfo.json at build
 * time. The baked key is the ONLY source in a distributed packaged app, whose
 * runtime env has none of the build shell's vars.
 */
export function resolveTelemetryCredentials(): TelemetryCredentials {
  const buildInfo = readBuildInfo();
  return {
    sentryDsn: asCred(process.env.SENTRY_DSN) ?? asCred(buildInfo?.sentryDsn),
    aptabaseAppKey: asCred(process.env.APTABASE_APP_KEY) ?? asCred(buildInfo?.aptabaseAppKey),
    environment: environmentFromBuildInfo(app.isPackaged, buildInfo),
  };
}
