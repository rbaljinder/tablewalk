/**
 * The database browser's looks to choose from, besides its own. The browser's own look (looks/native.css) is Folio —
 * warm archival paper, printed book tables, and deep forest-green links: what "default" means here. The kit has no
 * default host look (its "default" is always the shared native tokens), so the browser draws its own over them as a
 * first-stylesheet rule keyed on no host look worn; that is also why it paints with the first load, with no sheet
 * fetched before boot. Instrument (Stone, Graphite, Fog, Slate, Ink), Obsidian, Braun, Broadsheet, Blueprint and
 * Console remain selectable host looks.
 *
 * Not the App framework's looks. The Workbench wears its own tokens and no App look (docs/design.md, "Two dresses");
 * these are the kit's host looks (visualTheme.ts `registerHostLooks`): they appear in Preferences beside the kit's,
 * persist under the Workbench's look key, and set `data-host-look` on the root, which each stylesheet is keyed on. A
 * look's sheet is fetched only when it is worn, and waited for before the shell boots, so the first paint carries none.
 * `?look=folio` (or `?look=default`) is the native default; `?look=instrument` (or `&palette=stone`, `graphite`, `fog`,
 * `slate`, `ink`) picks one of Instrument's palettes, and `?look=obsidian` (or `braun`, `broadsheet`, `blueprint`,
 * `console`) picks any other look from the address.
 *
 * Instrument's palettes are host looks of their own (`instrument-<palette>`) over one sheet (`looks/instrument.css`,
 * which imports `looks/instrument-base.css` for the hairline grid): the kit offers a Palette choice only for its own
 * looks (visualTheme.ts `visualPaletteOptions`), so here they stand beside each other in the picker.
 */
import { registerHostLooks, setVisualPalette, setVisualTheme, visualThemeOptions } from '@mistriwork/kit/client/visualTheme.js';

const instrument = () => import('./looks/instrument.css');

/** Instrument's palettes: id, name, and the picker's swatches (ground, ink, accent). Colour + hairline grid
    (instrument.css + instrument-base.css), loaded on demand now that Folio is the native default. */
const PALETTES = /** @type {[string, string, string[]][]} */ ([
  ['stone', 'Stone', ['#f5f4f1', '#1d1b18', '#136a5e']],
  ['graphite', 'Graphite', ['#f6f7f9', '#15171c', '#3d5bd9']],
  ['fog', 'Fog', ['#f5f5f5', '#171717', '#4d6b2b']],
  ['slate', 'Slate', ['#f3f5f7', '#141a21', '#e9a23b']],
  ['ink', 'Ink', ['#f6f6f7', '#0c0c0f', '#6b3fd4']],
]);

const LOOKS = [
  {
    id: 'blueprint',
    label: 'Blueprint',
    sheet: () => import('./looks/blueprint.css'),
    swatches: ['#dde8f5', '#0a2550', '#123f94'],
  },
  {
    id: 'console',
    label: 'Console',
    sheet: () => import('./looks/console.css'),
    swatches: ['#fcfcf8', '#161b17', '#1f5c33'],
  },
  ...PALETTES.map(([id, name, swatches]) => ({ id: `instrument-${id}`, label: `Instrument ${name}`, sheet: instrument, swatches })),
  {
    id: 'obsidian',
    label: 'Obsidian',
    sheet: () => import('./looks/obsidian.css'),
    swatches: ['#ecedf2', '#111319', '#5e6ad2'],
  },
  {
    id: 'braun',
    label: 'Braun',
    sheet: () => import('./looks/braun.css'),
    swatches: ['#dedcd4', '#171c18', '#e04619'],
  },
  {
    id: 'broadsheet',
    label: 'Broadsheet',
    sheet: () => import('./looks/broadsheet.css'),
    swatches: ['#fff4ea', '#1f1a17', '#990f3d'],
  },
];

/** Declared before the shell boots, once; a `?look=` in the address is taken after, then dropped from it. */
export function declareHostLooks() {
  registerHostLooks(LOOKS);
  const here = new URL(window.location.href);
  if (!here.searchParams.has('look')) return;
  const look = here.searchParams.get('look');
  const palette = here.searchParams.get('palette');
  /* Folio is the native default; `?look=instrument` resolves to Instrument Graphite (or the named Instrument palette). */
  const asked = look === 'folio' ? 'default' : look === 'instrument' ? `instrument-${palette || 'graphite'}` : look;
  /* Stored as the Preferences picker stores it (any host look or built-in kit look this screen offers; an unknown name lands on the native default). */
  const known = Boolean(asked && visualThemeOptions().some((option) => option.value === asked));
  setVisualTheme(known && asked ? asked : 'default');
  if (palette && look !== 'instrument' && known) setVisualPalette(palette);
  here.searchParams.delete('look');
  here.searchParams.delete('palette');
  // host-global: the address bar loses ?look= before the shell mounts; no walk exists yet to push into.
  window.history.replaceState(window.history.state, '', here);
}
