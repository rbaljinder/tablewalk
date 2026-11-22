/** `?look=` links select both host looks and built-in kit presets offered in Preferences, then strip the query parameters. */
import { afterEach, expect, test } from 'vitest';
import { visualThemeChoice, visualPaletteChoice } from '@mistriwork/kit/client/visualTheme.js';
import { declareHostLooks } from './hostLooks.js';

afterEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

test('selects built-in kit looks, Instrument palettes, and falls back to default for unknown looks', () => {
  window.history.replaceState(null, '', '/demo/customer?look=sage');
  declareHostLooks();
  expect(visualThemeChoice()).toBe('sage');
  expect(window.location.search).toBe('');

  window.history.replaceState(null, '', '/demo/customer?look=instrument&palette=fog');
  declareHostLooks();
  expect(visualThemeChoice()).toBe('instrument-fog');
  expect(window.location.search).toBe('');

  window.history.replaceState(null, '', '/demo/customer?look=lumen&palette=teal');
  declareHostLooks();
  expect(visualThemeChoice()).toBe('lumen');
  expect(visualPaletteChoice()).toBe('teal');

  for (const look of ['obsidian', 'braun', 'broadsheet']) {
    window.history.replaceState(null, '', `/demo/customer?look=${look}`);
    declareHostLooks();
    expect(visualThemeChoice()).toBe(look);
    expect(window.location.search).toBe('');
  }

  window.history.replaceState(null, '', '/demo/customer?look=unknown-theme');
  declareHostLooks();
  expect(visualThemeChoice()).toBe('default');
});
