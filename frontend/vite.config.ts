import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Overridable so a verification instance can lease its own renderer port
    // (CYBOFLOW_VITE_PORT) alongside a scoped CDP port + CYBOFLOW_DIR data
    // dir, giving it full isolation from the developer's own `pnpm dev`
    // instance — see docs/proposals/verification-setup-flow.md §5.4 "Dogfood
    // prerequisite". Default matches the historical hardcoded port exactly.
    port: Number(process.env.CYBOFLOW_VITE_PORT ?? 4521),
    // Keep strict: the whole point of leasing a port for a verify run is to
    // honor it exactly, never silently fall back to a different one.
    strictPort: true
  },
  base: './',
  build: {
    // Ensure assets are copied and paths are relative
    assetsDir: 'assets',
    // Copy public files to dist
    copyPublicDir: true
  },
  // NOTE: test config lives in vitest.config.ts (which vitest prefers over this
  // file). Keeping a `test` block here breaks `tsc -b` in build:frontend because
  // vite@6's UserConfig has no `test` key and the vitest@2 augmentation targets a
  // duplicate vite@5 install — see vitest.config.ts for the canonical settings.
});
