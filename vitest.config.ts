/**
 * Component tests, in a DOM.
 *
 * `npm test` runs the server, the adapters and the DOM-free client modules under node:test; the browser suite drives
 * the whole page in Chromium. Between them sits this: a component drawn into happy-dom, driven with a keyboard and a
 * mouse, against a fetch that answers like the server would.
 */
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vite.config.js';

export default mergeConfig(
  base,
  defineConfig({
    test: {
      root: '.',
      include: ['src/**/*.test.{ts,tsx}'],
      environment: 'happy-dom',
      // The framework's client modules are installed built, and Vitest would load them as external Node modules that a
      // `vi.mock` cannot reach (the monorepo's tests mock the same modules as source). Inlined, they go through Vite like the
      // source did.
      server: { deps: { inline: [/@mistriwork\//] } },
      // Whole-page imports and isolated DOMs compete for memory on developer machines.
      maxWorkers: 2,
      setupFiles: ['test/components.setup.ts'],
      // Removes the temp folder Vitest leaves behind after each run (see the file).
      globalSetup: ['test/components.globalSetup.ts'],
    },
  }),
);
