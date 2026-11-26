/** `?look=` links select both host looks and built-in kit presets offered in Preferences, then strip the query parameters. */
import { afterEach, expect, test } from 'vitest';
import { setVisualTheme, visualThemeChoice, visualPaletteChoice } from '@mistriwork/kit/client/visualTheme.js';
import { declareHostLooks } from './hostLooks.js';
import { wearWorkbenchLook } from './workbenchLook.js';

afterEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  setVisualTheme('default');
  wearWorkbenchLook();
});

test('selects built-in kit looks, Instrument palettes, and falls back to default for unknown looks', () => {
  window.history.replaceState(null, '', '/demo/customer?look=sage');
  declareHostLooks();
  expect(visualThemeChoice()).toBe('sage');
  expect(window.location.search).toBe('');

  window.history.replaceState(null, '', '/demo/customer?look=folio');
  declareHostLooks();
  expect(visualThemeChoice()).toBe('default');
  expect(window.location.search).toBe('');

  window.history.replaceState(null, '', '/demo/customer?look=instrument');
  declareHostLooks();
  expect(visualThemeChoice()).toBe('instrument-graphite');
  expect(window.location.search).toBe('');

  window.history.replaceState(null, '', '/demo/customer?look=instrument&palette=fog');
  declareHostLooks();
  expect(visualThemeChoice()).toBe('instrument-fog');
  expect(window.location.search).toBe('');

  window.history.replaceState(null, '', '/demo/customer?look=lumen&palette=teal');
  declareHostLooks();
  expect(visualThemeChoice()).toBe('lumen');
  expect(visualPaletteChoice()).toBe('teal');

  for (const look of ['gallery', 'obsidian', 'braun', 'broadsheet']) {
    window.history.replaceState(null, '', `/demo/customer?look=${look}`);
    declareHostLooks();
    expect(visualThemeChoice()).toBe(look);
    expect(window.location.search).toBe('');
  }

  window.history.replaceState(null, '', '/demo/customer?look=unknown-theme');
  declareHostLooks();
  expect(visualThemeChoice()).toBe('default');
});

test('wearWorkbenchLook writes derived kit tokens and clears kit root attributes on default and host looks', () => {
  declareHostLooks();
  setVisualTheme('gallery');
  wearWorkbenchLook();
  const root = document.documentElement;
  expect(root.style.getPropertyValue('--heat-top')).toMatch(/^\d+%$/);

  setVisualTheme('obsidian');
  wearWorkbenchLook();
  expect(root.style.getPropertyValue('--heat-top')).toBe('');
  for (const attr of ['data-nav-current', 'data-pill-radius', 'data-control-radius', 'data-rules-control', 'data-field-fill']) {
    expect(root.hasAttribute(attr)).toBe(false);
  }
});
