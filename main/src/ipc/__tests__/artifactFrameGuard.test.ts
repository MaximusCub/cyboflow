/**
 * Unit tests for artifactFrameGuard — the pure navigation-confinement predicate
 * behind the main-process `will-frame-navigate` interception that keeps a static
 * ui-prototype/generic mockup frame (about:srcdoc, bare sandbox) from navigating
 * (and thus beaconing) off its own document.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  shouldBlockArtifactFrameNavigation,
  isExternallyOpenable,
  shouldBlockScriptedFrameNavigation,
  shouldBlockScriptedFrameNavigationFromRegistry,
  registerScriptedFrameOrigin,
  unregisterScriptedFrameOrigin,
  scriptedFrameOriginsSnapshot,
} from '../artifactFrameGuard';

describe('shouldBlockArtifactFrameNavigation', () => {
  it('BLOCKS an about:srcdoc frame navigating to an http(s) URL (the beacon vector)', () => {
    expect(shouldBlockArtifactFrameNavigation('about:srcdoc', 'https://attacker.example/beacon', false)).toBe(true);
    expect(shouldBlockArtifactFrameNavigation('about:srcdoc', 'http://evil/x', false)).toBe(true);
  });

  it('BLOCKS an about:srcdoc frame navigating to data:/file:/custom schemes', () => {
    expect(shouldBlockArtifactFrameNavigation('about:srcdoc', 'data:text/html,x', false)).toBe(true);
    expect(shouldBlockArtifactFrameNavigation('about:srcdoc', 'file:///etc/passwd', false)).toBe(true);
    expect(shouldBlockArtifactFrameNavigation('about:srcdoc', 'weird://x', false)).toBe(true);
  });

  it('ALLOWS the initial about:srcdoc / about:blank load of the frame', () => {
    expect(shouldBlockArtifactFrameNavigation('about:srcdoc', 'about:srcdoc', false)).toBe(false);
    expect(shouldBlockArtifactFrameNavigation('about:srcdoc', 'about:blank', false)).toBe(false);
  });

  it('NEVER touches the app main frame', () => {
    expect(shouldBlockArtifactFrameNavigation('about:srcdoc', 'https://evil/x', true)).toBe(false);
    expect(shouldBlockArtifactFrameNavigation('file:///app/index.html', 'https://evil/x', true)).toBe(false);
  });

  it('NEVER touches the legacy localhost dev-server prototype iframe (not about:srcdoc)', () => {
    // A real cross-origin app frame that legitimately navigates itself.
    expect(shouldBlockArtifactFrameNavigation('http://localhost:8081', 'http://localhost:8081/page', false)).toBe(false);
    expect(shouldBlockArtifactFrameNavigation('http://localhost:8081', 'https://cdn.example/x', false)).toBe(false);
  });
});

describe('isExternallyOpenable', () => {
  it('is true only for http(s) targets', () => {
    expect(isExternallyOpenable('https://x/y')).toBe(true);
    expect(isExternallyOpenable('http://x')).toBe(true);
    expect(isExternallyOpenable('data:text/html,x')).toBe(false);
    expect(isExternallyOpenable('file:///x')).toBe(false);
    expect(isExternallyOpenable('mailto:a@b.c')).toBe(false);
  });
});

// Design Mode v1 — the scripted-frame (loopback-origin) guard.
const ORIGIN = 'http://127.0.0.1:9000';
const OTHER_ORIGIN = 'http://127.0.0.1:9100';
const origins = new Set([ORIGIN]);

describe('shouldBlockScriptedFrameNavigation', () => {
  it('ALLOWS a same-origin navigation (reload / respawn / same-origin hop)', () => {
    expect(shouldBlockScriptedFrameNavigation(`${ORIGIN}/tok/prototype/index.html`, `${ORIGIN}/tok/prototype/index.html`, false, origins)).toBe(false);
    // Bare origin (reload) and a same-origin sub-path both allowed.
    expect(shouldBlockScriptedFrameNavigation(`${ORIGIN}/tok/prototype/index.html`, ORIGIN, false, origins)).toBe(false);
    expect(shouldBlockScriptedFrameNavigation(`${ORIGIN}/a`, `${ORIGIN}/b`, false, origins)).toBe(false);
  });

  it('ALLOWS the initial about:blank / empty-frame load TO a registered origin', () => {
    expect(shouldBlockScriptedFrameNavigation('about:blank', `${ORIGIN}/tok/prototype/index.html`, false, origins)).toBe(false);
    expect(shouldBlockScriptedFrameNavigation('', `${ORIGIN}/tok/prototype/index.html`, false, origins)).toBe(false);
  });

  it('BLOCKS a confined frame navigating cross-origin http(s) (no external open path)', () => {
    expect(shouldBlockScriptedFrameNavigation(`${ORIGIN}/tok/prototype/index.html`, 'https://attacker.example/beacon', false, origins)).toBe(true);
    expect(shouldBlockScriptedFrameNavigation(`${ORIGIN}/tok/prototype/index.html`, `${OTHER_ORIGIN}/x`, false, origins)).toBe(true);
  });

  it('BLOCKS a confined frame navigating to about:/data:/file: schemes', () => {
    for (const target of ['about:blank', 'about:srcdoc', 'data:text/html,x', 'file:///etc/passwd', 'weird://x']) {
      expect(shouldBlockScriptedFrameNavigation(`${ORIGIN}/tok/prototype/index.html`, target, false, origins)).toBe(true);
    }
  });

  it('does NOT confuse a sibling-port origin for the registered one', () => {
    // Target at :90001 must not be treated as same-origin with :9000.
    expect(shouldBlockScriptedFrameNavigation(`${ORIGIN}/a`, 'http://127.0.0.1:90001/a', false, origins)).toBe(true);
  });

  it('NEVER confines the app main frame', () => {
    expect(shouldBlockScriptedFrameNavigation(`${ORIGIN}/a`, 'https://evil/x', true, origins)).toBe(false);
  });

  it('leaves a non-registered-origin frame alone (returns false, deferring to other guards)', () => {
    expect(shouldBlockScriptedFrameNavigation('http://localhost:8081', 'https://cdn.example/x', false, origins)).toBe(false);
    expect(shouldBlockScriptedFrameNavigation('about:srcdoc', 'https://evil/x', false, origins)).toBe(false);
  });
});

describe('scripted-frame origin registry + shell.openExternal invariant', () => {
  it('registers / unregisters origins the live wrapper reads', () => {
    registerScriptedFrameOrigin(ORIGIN);
    expect(scriptedFrameOriginsSnapshot()).toContain(ORIGIN);
    expect(shouldBlockScriptedFrameNavigationFromRegistry(`${ORIGIN}/a`, 'https://evil/x', false)).toBe(true);
    unregisterScriptedFrameOrigin(ORIGIN);
    expect(scriptedFrameOriginsSnapshot()).not.toContain(ORIGIN);
    // Once unregistered, the frame is no longer ours — the scripted guard defers.
    expect(shouldBlockScriptedFrameNavigationFromRegistry(`${ORIGIN}/a`, 'https://evil/x', false)).toBe(false);
  });

  it('NEVER offers a blocked scripted-frame target to shell.openExternal', () => {
    // Mirrors the will-frame-navigate handler ordering (scripted guard first,
    // srcdoc guard second): a blocked scripted-frame navigation must preventDefault
    // and do NOTHING else — no OS-browser open, even for an http(s) target.
    registerScriptedFrameOrigin(ORIGIN);
    const openExternal = vi.fn();
    const handle = (frameUrl: string, targetUrl: string, isMainFrame: boolean): void => {
      if (shouldBlockScriptedFrameNavigationFromRegistry(frameUrl, targetUrl, isMainFrame)) {
        return; // preventDefault + nothing else
      }
      if (shouldBlockArtifactFrameNavigation(frameUrl, targetUrl, isMainFrame)) {
        if (isExternallyOpenable(targetUrl)) openExternal(targetUrl);
      }
    };
    handle(`${ORIGIN}/tok/prototype/index.html`, 'https://attacker.example/beacon?secrets=1', false);
    handle(`${ORIGIN}/tok/prototype/index.html`, 'http://evil/x', false);
    expect(openExternal).not.toHaveBeenCalled();
    unregisterScriptedFrameOrigin(ORIGIN);
  });
});
