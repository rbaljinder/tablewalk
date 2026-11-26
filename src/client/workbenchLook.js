/**
 * The Workbench's own look on the page: its native default, or the look its
 * reader picked (visualTheme.ts), with none of an App's colours. Worn each
 * brand pass (shells.ts `ShellChrome.dress`) and again when the look, the
 * mode or the system's scheme changes.
 *
 * An App's page wears its look through appTheme.js, which carries the App's
 * accent, branding and authored overrides over the same tokens; this is that
 * writer's Workbench half, which the database browser keeps for itself, so
 * its page never loads the App framework to be dressed.
 */
import {
  configureVisualThemes,
  customThemePartTokens,
  customThemeTokens,
  VISUAL_THEME_EVENT,
  hostLookChoice,
  visualThemeChoice,
  visualThemeOverrides,
  visualThemePalette,
} from '@mistriwork/kit/client/visualTheme.js';
import { effectiveThemePalette } from '@mistriwork/engine/shared/themePresets.js';
import { fieldEdge, heatTop } from '@mistriwork/engine/shared/themeColor.js';
import { setThemeScheme } from '@mistriwork/kit/client/theme.js';
import { setDensityDefault } from '@mistriwork/kit/client/density.js';
import { addHostListener, shellBody, shellRoot } from '@mistriwork/kit/client/shellHost.js';

/** The tokens the last pass wrote, so the next one removes what it no longer says. */
let customTokenKeys = /** @type {string[]} */ ([]);
let partTokenKeys = /** @type {string[]} */ ([]);
let watched = false;

const LOOK_ROOT_ATTRS = ['data-nav-current', 'data-pill-radius', 'data-control-radius', 'data-rules-control', 'data-field-fill'];

export function wearWorkbenchLook() {
  configureVisualThemes(undefined, undefined, false, undefined, undefined, { locked: false, isolated: false });
  watch();
  /* The Workbench has no theme that says it is dark: the reader's mode stands. */
  setThemeScheme(undefined);
  const style = shellBody().style;
  const parts = customThemePartTokens();
  for (const key of partTokenKeys) if (!(key in parts)) style.removeProperty(key);
  for (const [key, value] of Object.entries(parts)) style.setProperty(key, value);
  partTokenKeys = Object.keys(parts);
  shellBody().classList.remove('app-readonly');
  for (const key of ['--accent', '--accent-ink', '--on-accent', '--focus', '--link', '--accent-soft', '--radius', '--chart-1'])
    style.removeProperty(key);
  const rootEl = shellRoot();
  const root = rootEl.style;
  /* The native default takes every look token back, and keeps style.css's code face. A host look (hostLooks.js) is the
     same here: its sheet, keyed on data-host-look, writes its own tokens, and the kit has no theme of that name. */
  if (visualThemeChoice() === 'default' || hostLookChoice()) {
    for (const key of customTokenKeys) root.removeProperty(key);
    customTokenKeys = [];
    for (const attr of LOOK_ROOT_ATTRS) rootEl.removeAttribute(attr);
    root.removeProperty('--mono');
    setDensityDefault(undefined);
    return;
  }
  /* A look the reader picked: its tokens on the root, its corner unless it is square, its data face. */
  const look = visualThemeOverrides();
  const dark = rootEl.dataset.theme === 'dark' || (!rootEl.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const tokens = customThemeTokens(dark);
  const worn = effectiveThemePalette(visualThemePalette(dark), dark, {});
  tokens['--heat-top'] = `${Math.round(heatTop(worn) * 100)}%`;
  const edge = fieldEdge(worn);
  if (edge) tokens['--field-edge'] = edge;
  if (look.radius) tokens['--radius'] = look.radius;
  for (const key of customTokenKeys) if (!(key in tokens)) root.removeProperty(key);
  for (const [key, value] of Object.entries(tokens)) root.setProperty(key, value);
  customTokenKeys = Object.keys(tokens);
  rootEl.toggleAttribute('data-nav-current', '--nav-current' in tokens);
  rootEl.toggleAttribute('data-pill-radius', '--pill-radius' in tokens);
  rootEl.toggleAttribute('data-control-radius', '--control-radius' in tokens);
  rootEl.toggleAttribute('data-rules-control', '--control-border-w' in tokens);
  rootEl.toggleAttribute('data-field-fill', '--field-fill' in tokens);
  root.setProperty('--mono', look.font);
  setDensityDefault(undefined);
}

/* The look's tokens depend on the mode in force, so they are worn again when the system's scheme flips, the reader
   picks a look, or the mode is stamped. Attached once. */
function watch() {
  if (watched) return;
  watched = true;
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', wearWorkbenchLook);
  addHostListener(window, VISUAL_THEME_EVENT, wearWorkbenchLook);
  new MutationObserver(wearWorkbenchLook).observe(shellRoot(), { attributes: true, attributeFilter: ['data-theme'] });
}
