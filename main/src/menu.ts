/**
 * Custom application menu, installed once at boot (see `index.ts`'s
 * `app.whenReady()`). The app never called `Menu.setApplicationMenu` before
 * this — Electron's stock default menu was live, and that default menu's View
 * submenu binds `CmdOrCtrl+R` to `role: 'reload'`, which SWALLOWS every
 * `Cmd+R` keydown before it ever reaches the renderer's keyboard-shortcut
 * handler (the `toggleReviewQueue` action's default binding).
 *
 * This reproduces the stock menu structure (role-based items, so every
 * standard behavior — Cmd+H hide, Cmd+Q quit, Cmd+Z/X/C/V edit roles, window
 * cycling, zoom, fullscreen, ...) is preserved verbatim, with ONE deliberate
 * change: the View submenu is hand-built so `reload` moves off `Cmd+R` onto
 * `Shift+Cmd+R`, and `forceReload` (whose OWN stock default is
 * `Shift+Cmd+R`) is moved onto `Alt+Cmd+R` so it can't collide with reload's
 * new accelerator. Net effect: plain Cmd+R carries NO menu accelerator on any
 * platform, so it reaches the renderer; Shift+Cmd+R still reloads.
 */
import { Menu, type MenuItemConstructorOptions } from 'electron';

/** The hand-built View submenu — the one deliberate deviation from stock. */
function buildViewSubmenu(): MenuItemConstructorOptions[] {
  return [
    // Stock default accelerator is 'CmdOrCtrl+R' — overridden so plain Cmd+R
    // (Ctrl+R elsewhere) reaches the renderer's shortcut handler instead.
    { role: 'reload', accelerator: 'Shift+CmdOrCtrl+R' },
    // Stock default accelerator is 'Shift+CmdOrCtrl+R' — moved to Alt so it
    // no longer shadows reload's new accelerator above.
    { role: 'forceReload', accelerator: 'Alt+CmdOrCtrl+R' },
    { role: 'toggleDevTools' },
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];
}

/** Build the full application menu template for the current platform. */
export function buildApplicationMenuTemplate(): MenuItemConstructorOptions[] {
  const isMac = process.platform === 'darwin';

  // File: 'Close Window' on every platform; non-mac also carries Quit (mac's
  // Quit lives in the app menu below, via role 'appMenu').
  const fileSubmenu: MenuItemConstructorOptions[] = isMac
    ? [{ role: 'close' }]
    : [{ role: 'close' }, { type: 'separator' }, { role: 'quit' }];

  return [
    // macOS-only app menu (the bundle-name menu) — keeps About/Services/Hide
    // family/Quit exactly as the stock menu provides them.
    ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    { label: 'File', submenu: fileSubmenu },
    { role: 'editMenu' },
    { label: 'View', submenu: buildViewSubmenu() },
    { role: 'windowMenu' },
  ];
}

/**
 * Install the custom application menu. Idempotent (Electron replaces the
 * previous menu on each call) — call once at boot, before or after the first
 * window is created; the menu is process-global, not per-window.
 */
export function installApplicationMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildApplicationMenuTemplate()));
}
