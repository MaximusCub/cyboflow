/**
 * main/src/menu.ts — the custom application menu template.
 *
 * The ONE thing this file exists for is getting plain `CmdOrCtrl+R` OFF the
 * menu: Electron's stock default menu binds it to `role: 'reload'`, and a menu
 * accelerator swallows the keydown before the renderer's keyboard-shortcut
 * engine ever sees it — which would silently kill the `toggleReviewQueue`
 * action's default binding. That property is asserted here by WALKING the whole
 * template (a nested submenu is just as capable of re-introducing the
 * accelerator as a top-level item), on BOTH platform branches.
 *
 * `buildApplicationMenuTemplate` is a pure function of `process.platform`, so
 * the electron module is mocked and only the platform is stubbed — no
 * `app.whenReady()`, no window.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';

// The shared test setup's electron mock carries no `Menu` — supply one here so
// the module's named import resolves. Only buildApplicationMenuTemplate is
// exercised; Menu itself is never called.
vi.mock('electron', () => ({
  Menu: {
    setApplicationMenu: vi.fn(),
    buildFromTemplate: vi.fn(),
  },
}));

import { buildApplicationMenuTemplate } from '../menu';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, writable: true, configurable: true });
}

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
});

/** Every item in the template, submenus included, flattened depth-first. */
function walk(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = [];
  for (const item of items) {
    out.push(item);
    const submenu = item.submenu;
    if (Array.isArray(submenu)) out.push(...walk(submenu));
  }
  return out;
}

/** The single item carrying `role`, or undefined. */
function itemWithRole(
  items: MenuItemConstructorOptions[],
  role: string,
): MenuItemConstructorOptions | undefined {
  return walk(items).find((item) => item.role === role);
}

describe('buildApplicationMenuTemplate — Cmd+R is free for the renderer', () => {
  it('binds CmdOrCtrl+R nowhere in the mac template', () => {
    setPlatform('darwin');
    const accelerators = walk(buildApplicationMenuTemplate()).map((item) => item.accelerator);
    expect(accelerators).not.toContain('CmdOrCtrl+R');
  });

  it('binds CmdOrCtrl+R nowhere in the non-mac template', () => {
    setPlatform('linux');
    const accelerators = walk(buildApplicationMenuTemplate()).map((item) => item.accelerator);
    expect(accelerators).not.toContain('CmdOrCtrl+R');
  });

  it('moves reload onto Shift+CmdOrCtrl+R on both platforms', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      setPlatform(platform);
      const reload = itemWithRole(buildApplicationMenuTemplate(), 'reload');
      expect(reload).toBeDefined();
      expect(reload?.accelerator).toBe('Shift+CmdOrCtrl+R');
    }
  });

  it('moves forceReload onto Alt+CmdOrCtrl+R so it cannot shadow reload', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      setPlatform(platform);
      const forceReload = itemWithRole(buildApplicationMenuTemplate(), 'forceReload');
      expect(forceReload).toBeDefined();
      expect(forceReload?.accelerator).toBe('Alt+CmdOrCtrl+R');
    }
  });
});

describe('buildApplicationMenuTemplate — stock structure is preserved', () => {
  it('the mac template keeps the appMenu / editMenu / windowMenu roles', () => {
    setPlatform('darwin');
    const template = buildApplicationMenuTemplate();
    const roles = template.map((item) => item.role);
    expect(roles).toContain('appMenu');
    expect(roles).toContain('editMenu');
    expect(roles).toContain('windowMenu');
  });

  it('the non-mac template drops appMenu but carries a quit role', () => {
    setPlatform('linux');
    const template = buildApplicationMenuTemplate();
    expect(template.map((item) => item.role)).not.toContain('appMenu');
    expect(itemWithRole(template, 'quit')).toBeDefined();
  });

  it('the mac template has no quit role of its own (it lives inside appMenu)', () => {
    setPlatform('darwin');
    expect(itemWithRole(buildApplicationMenuTemplate(), 'quit')).toBeUndefined();
  });
});
