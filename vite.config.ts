/**
 * The database browser's page: the kit's page (`@mistriwork/kit/vite`) with this product's main, the entry and the
 * Workbench's chunk.
 *
 * One config for three uses. `npm run build` bundles the client into dist/client — minified, content-named,
 * precompressed — which is what the published package serves, so `npx tablewalk` has no build step. Under tsx
 * (`npm start`, `npm run dev`, every test suite) the server serves the kit's client through Vite's middleware
 * (@mistriwork/engine's devclient) with this same config, so an edit is a reload away. Vitest reads it too.
 *
 * Every name imported here is on the kit's host list: the modules a product outside the kit's repository may import.
 */
import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kitClientConfig, kitModule } from '@mistriwork/kit/vite';
import { SURFACE_PAGES } from '@mistriwork/engine/server/clientSurface.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLIENT = resolve(HERE, 'src/client');

export default defineConfig(
  kitClientConfig({
    workspace: HERE,
    main: resolve(CLIENT, 'workbenchShell.js'),
    clients: [CLIENT],
    build: {
      outDir: resolve(HERE, 'dist/client'),
      /* The kit's shell, this product's main and its tools: its only page fetches all of it at once. */
      surfaces: { workbench: [kitModule('app.js'), resolve(CLIENT, 'workbenchShell.js'), resolve(CLIENT, 'workbench.js')] },
      /* index.html is the entry alone. */
      pages: { [SURFACE_PAGES.workbench]: ['workbench'] },
    },
  }),
);
