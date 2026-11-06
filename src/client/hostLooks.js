/**
 * The database browser's own looks: directions to choose from, worn over the native tokens. Blueprint and Console are
 * the first round's novelty looks; Instrument and Folio are the refined round, the same restraint as the native look
 * with one point of view each.
 *
 * Not the App framework's looks. The Workbench wears its own tokens and no App look (docs/design.md, "Two dresses");
 * these are the kit's host looks (visualTheme.ts `registerHostLooks`): they appear in Preferences beside the kit's,
 * persist under the Workbench's look key, and set `data-host-look` on the root, which each stylesheet is keyed on. A
 * look's sheet is fetched only when it is worn, and waited for before the shell boots, so the first paint carries none.
 * `?look=instrument` (or `folio`, `blueprint`, `console`, or `default`) picks one from the address, as a link to a look;
 * `&palette=stone` (or `slate`, `ink`, `fog`; `graphite` is Instrument's own) picks one of Instrument's palettes.
 *
 * Instrument's palettes are host looks of their own (`instrument-<palette>`) over its one sheet: the kit offers a
 * Palette choice only for its own looks (visualTheme.ts `visualPaletteOptions`), so here they stand beside Instrument
 * in the picker, each named for it.
 */
import { registerHostLooks, setVisualTheme } from '@mistriwork/kit/client/visualTheme.js';

const instrument = () => import('./looks/instrument.css');

/** Instrument's palettes: id, name, and the picker's swatches (ground, ink, accent). Colour only (instrument.css): stone
    and teal, slate and amber, ink and violet, fog and moss. A name stays short, so a phone's picker keeps its width. */
const PALETTES = /** @type {[string, string, string[]][]} */ ([
  ['stone', 'Stone', ['#f5f4f1', '#1d1b18', '#136a5e']],
  ['slate', 'Slate', ['#f3f5f7', '#141a21', '#e9a23b']],
  ['ink', 'Ink', ['#f6f6f7', '#0c0c0f', '#6b3fd4']],
  ['fog', 'Fog', ['#f5f5f5', '#171717', '#4d6b2b']],
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
  {
    id: 'instrument',
    label: 'Instrument',
    sheet: instrument,
    swatches: ['#f6f7f9', '#15171c', '#3d5bd9'],
  },
  ...PALETTES.map(([id, name, swatches]) => ({ id: `instrument-${id}`, label: `Instrument ${name}`, sheet: instrument, swatches })),
  {
    id: 'folio',
    label: 'Folio',
    sheet: () => import('./looks/folio.css'),
    swatches: ['#fcfbf9', '#1c1a17', '#1e6a55'],
  },
];

/** Declared before the shell boots, once; a `?look=` in the address is taken after, then dropped from it. */
export function declareHostLooks() {
  registerHostLooks(LOOKS);
  const here = new URL(window.location.href);
  if (!here.searchParams.has('look')) return;
  const palette = here.searchParams.get('palette');
  /* A palette names Instrument's variant; Instrument's own colours are its `graphite`. */
  const asked = [here.searchParams.get('look'), palette && palette !== 'graphite' ? palette : null].filter(Boolean).join('-');
  /* Stored as the Preferences picker stores it (an unknown name is the native default). */
  setVisualTheme(asked && LOOKS.some((look) => look.id === asked) ? asked : 'default');
  here.searchParams.delete('look');
  here.searchParams.delete('palette');
  // host-global: the address bar loses ?look= before the shell mounts; no walk exists yet to push into.
  window.history.replaceState(window.history.state, '', here);
}
