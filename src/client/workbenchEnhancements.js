/**
 * Runtime workspace refinements for the Refined Instrument Pro Workbench:
 *   1. Segmented sidebar scope (`All · Tables · Views`) + `Focused` connection indicator
 *   2. Collapsible single-line quick-filter toggle (`Filters`) in the table room tab strip
 *   3. Schema landing polish: de-duplicated ER heading, accurate runner-up starter chip
 *      captions, and 1-click `Check shape & perf` / `Join paths` launchers
 *   4. Per-column `masked` badges in Grid headers and Record fields on redacted connections
 *   5. Inline Column Profile popover + 1-click `+ Show <fk>.<col>` in `.th-menu`
 *   6. Compiled-SQL `Plan` button (`EXPLAIN` / `EXPLAIN QUERY PLAN`) in `#explain-pane`
 *   7. Live external MCP agent topbar pill + background `Follow agent` co-browsing.
 *
 * Loaded dynamically from `workbench.js` so zero bytes land in the cold first-paint JS/CSS budget,
 * and every injected quick button carries `tabIndex = -1` so keyboard roving and Tab-stop order stay untouched.
 */
import { splitQuery } from '@mistriwork/engine/shared/clauses.js';
import {
  api,
  currentEntry,
  loadJson,
  quote,
  saveJson,
  state,
  toast,
  viewportBox,
  viewportSize,
  whenConnectionChanges,
} from '@mistriwork/kit/client/core.js';
import { canUseDatabaseTools } from '@mistriwork/kit/client/connectionScope.js';
import { formatNumber } from '@mistriwork/kit/client/locale.js';
import { menuMode } from '@mistriwork/kit/client/menu.js';
import { addPaletteSource } from '@mistriwork/kit/client/palette.js';
import { shell } from '@mistriwork/kit/client/shellMode.js';
import {
  addHostListener,
  navFollow,
  onNavigate,
  portalRoot,
  removeHostListener,
  shellBody,
  shellById,
  shellQuery,
  shellQueryAll,
} from '@mistriwork/kit/client/shellHost.js';
import { barSpan, extentOf, formatChartNumber, valueScale } from '@mistriwork/ui/charts/core.js';
import { computeColumnAggregates, formatResultExport } from '../shared/sqlScript.js';
import { say } from './copy/workbench/workbenchEnhancements.js';
import './workbenchEnhancements.css';

const FILTER_COLLAPSED_KEY = 'tablewalk.filters.collapsed';
const FOLLOW_AGENT_KEY = 'mistri.followAgent.v1';
const SAVED_FILTERS_KEY = 'mistri.views.v1';
const COMPOSER_VIEWS_KEY = 'mistri.composer.v1';
const PINS_KEY = 'mistri.pins.v1';
const RECENT_QUERIES_KEY = 'mistri.recentQueries.v1';
const MAX_RECENT_QUERIES = 15;

/**
 * Record a multi-token query or breakdown in a bounded per-database ring (up to 15),
 * ignoring empty strings and bare single-token table names.
 * @param {Record<string, string[]>} storeObj
 * @param {string} key
 * @param {string} rawQuery
 */
export function recordRecentQueryInStore(storeObj, key, rawQuery) {
  const q = String(rawQuery ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!q || !/\s/.test(q)) return false;
  const prev = Array.isArray(storeObj[key]) ? storeObj[key].filter((x) => typeof x === 'string') : [];
  storeObj[key] = [q, ...prev.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, MAX_RECENT_QUERIES);
  return true;
}

/** @param {string} connection */
function siblingGroupFor(connection) {
  const active = /** @type {any[]} */ (state.connections ?? []).find((c) => c.id === connection);
  if (!active?.database || (!active.siblings?.length && !active.explicit)) {
    return { groupKey: null, siblingIds: [connection] };
  }
  const otherIds = Array.isArray(active.siblings) ? active.siblings.map((s) => s.id) : [];
  return {
    groupKey: `@db:${String(active.database).toLowerCase()}`,
    siblingIds: [connection, ...otherIds],
  };
}

/**
 * Carry browser-saved table filters (`mistri.views.v1`), composed views (`mistri.composer.v1`),
 * and pinned columns (`mistri.pins.v1`) across sibling environments of the same logical database.
 * @param {string | null | undefined} fromId
 * @param {string} toId
 */
export function syncSiblingBrowserStores(fromId, toId) {
  const { groupKey, siblingIds } = siblingGroupFor(toId);
  if (!groupKey || siblingIds.length < 2) return;
  const sameGroup = Boolean(fromId && fromId !== toId && siblingIds.includes(fromId));

  // 1. Table saved filters: { [connId]: { [tableId]: Array<{ name, query }> } }
  const filtersAll = /** @type {Record<string, Record<string, Array<{ name: string; query: string }>>>} */ (
    loadJson(SAVED_FILTERS_KEY, {})
  );
  if (sameGroup && fromId && filtersAll[fromId] && filtersAll[groupKey]) {
    filtersAll[groupKey] = filtersAll[fromId];
    filtersAll[toId] = filtersAll[fromId];
    saveJson(SAVED_FILTERS_KEY, filtersAll);
  } else {
    const mergedTables = /** @type {Record<string, Array<{ name: string; query: string }>>} */ ({});
    let hasAny = false;
    const sources = sameGroup && fromId ? [fromId, groupKey, toId, ...siblingIds] : [toId, groupKey, ...siblingIds];
    for (const key of sources) {
      const byTable = filtersAll[key];
      if (!byTable || typeof byTable !== 'object') continue;
      for (const [tableId, list] of Object.entries(byTable)) {
        if (!Array.isArray(list) || !list.length) continue;
        hasAny = true;
        const bucket = (mergedTables[tableId] ??= []);
        for (const item of list) {
          if (item && typeof item.name === 'string' && !bucket.some((x) => x.name === item.name)) {
            bucket.push(item);
          }
        }
      }
    }
    if (hasAny) {
      filtersAll[groupKey] = mergedTables;
      filtersAll[toId] = mergedTables;
      saveJson(SAVED_FILTERS_KEY, filtersAll);
    }
  }

  // 2. Composed multi-table views: { [connId]: { views: Array<{ id, name, ... }>, pinned: string[] } }
  const composerAll = /** @type {Record<string, any>} */ (loadJson(COMPOSER_VIEWS_KEY, {}));
  /** @param {any} raw */
  const normalizeBucket = (raw) =>
    Array.isArray(raw) ? { views: raw, pinned: [] } : { views: raw?.views ?? [], pinned: raw?.pinned ?? [] };
  if (sameGroup && fromId && composerAll[fromId] && composerAll[groupKey]) {
    const latest = normalizeBucket(composerAll[fromId]);
    composerAll[groupKey] = latest;
    composerAll[toId] = latest;
    saveJson(COMPOSER_VIEWS_KEY, composerAll);
  } else {
    const seenIds = new Set();
    const views = [];
    const pinnedSet = new Set();
    const sources = sameGroup && fromId ? [fromId, groupKey, toId, ...siblingIds] : [toId, groupKey, ...siblingIds];
    for (const key of sources) {
      if (!composerAll[key]) continue;
      const b = normalizeBucket(composerAll[key]);
      for (const v of b.views) {
        const vid = v?.id ?? v?.name;
        if (vid && !seenIds.has(vid)) {
          seenIds.add(vid);
          views.push(v);
        }
      }
      for (const p of b.pinned) if (typeof p === 'string') pinnedSet.add(p);
    }
    if (views.length > 0) {
      const combined = { views, pinned: [...pinnedSet] };
      composerAll[groupKey] = combined;
      composerAll[toId] = combined;
      saveJson(COMPOSER_VIEWS_KEY, composerAll);
    }
  }

  // 3. Pinned columns: { [connId]: { [tableId]: string[] } }
  const pinsAll = /** @type {Record<string, Record<string, string[]>>} */ (loadJson(PINS_KEY, {}));
  if (sameGroup && fromId && pinsAll[fromId] && pinsAll[groupKey]) {
    pinsAll[groupKey] = pinsAll[fromId];
    pinsAll[toId] = pinsAll[fromId];
    saveJson(PINS_KEY, pinsAll);
  } else {
    const mergedPins = /** @type {Record<string, string[]>} */ ({});
    let hasPins = false;
    const sources = sameGroup && fromId ? [fromId, groupKey, toId, ...siblingIds] : [toId, groupKey, ...siblingIds];
    for (const key of sources) {
      const byTable = pinsAll[key];
      if (!byTable || typeof byTable !== 'object') continue;
      for (const [tableId, cols] of Object.entries(byTable)) {
        if (!Array.isArray(cols) || !cols.length) continue;
        hasPins = true;
        const set = new Set(mergedPins[tableId] ?? []);
        for (const c of cols) if (typeof c === 'string') set.add(c);
        mergedPins[tableId] = [...set];
      }
    }
    if (hasPins) {
      pinsAll[groupKey] = mergedPins;
      pinsAll[toId] = mergedPins;
      saveJson(PINS_KEY, pinsAll);
    }
  }
}

/**
 * Append a joined foreign-key dot-path (`customer_id.name`) to a query's `show` clause.
 * @param {string} queryText
 * @param {string} tableId
 * @param {string[]} baseColumns
 * @param {string} dotPath
 */
export function appendShowProjection(queryText, tableId, baseColumns, dotPath) {
  const base = (queryText ?? '').trim() || tableId;
  const parts = splitQuery(base);
  if (parts.show) {
    const rawCols = parts.show
      .replace(/^(?:show|select)\s+/i, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!rawCols.some((c) => c.toLowerCase() === dotPath.toLowerCase() || c.toLowerCase().startsWith(`${dotPath.toLowerCase()} as `))) {
      rawCols.push(dotPath);
    }
    parts.show = `show ${rawCols.join(', ')}`;
  } else {
    const initial = baseColumns.slice(0, 6);
    parts.show = `show ${[...initial, dotPath].join(', ')}`;
  }
  return [parts.table || tableId, parts.filter, parts.show, parts.sort, parts.limit]
    .filter((p) => p && String(p).trim())
    .join(' ')
    .trim();
}

/**
 * Append an equality filter condition to a query's filter clause.
 * @param {string} queryText
 * @param {string} tableId
 * @param {string} condition
 */
function appendEqualityFilter(queryText, tableId, condition) {
  const base = (queryText ?? '').trim() || tableId;
  const parts = splitQuery(base);
  parts.filter = parts.filter ? `${parts.filter} and ${condition}` : condition;
  return [parts.table || tableId, parts.filter, parts.show, parts.sort, parts.limit]
    .filter((p) => p && String(p).trim())
    .join(' ')
    .trim();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Inspect a grid cell's text for structured display (JSON pretty-print, ISO timestamps, UUIDs, multiline text).
 * @param {string} rawText
 * @param {boolean} [isNull]
 */
export function inspectCellValue(rawText, isNull = false) {
  if (isNull) {
    return { kind: /** @type {const} */ ('null'), formatted: 'NULL', meta: [] };
  }
  const trimmed = String(rawText ?? '').trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        const meta = Array.isArray(parsed)
          ? [say('cellMetaJsonItems', { count: parsed.length })]
          : [say('cellMetaJsonKeys', { count: Object.keys(parsed).length })];
        return { kind: /** @type {const} */ ('json'), formatted: JSON.stringify(parsed, null, 2), meta };
      }
    } catch {
      // Not valid JSON; fall through to text inspection.
    }
  }
  if (ISO_TS_RE.test(trimmed)) {
    const d = new Date(trimmed);
    if (!Number.isNaN(d.getTime())) {
      const utc = d.toISOString();
      const local = d.toLocaleString('en-US');
      return {
        kind: /** @type {const} */ ('timestamp'),
        formatted: trimmed,
        meta: [say('cellUtcLabel', { value: utc }), say('cellLocalLabel', { value: local })],
        utc,
        local,
      };
    }
  }
  if (UUID_RE.test(trimmed)) {
    return { kind: /** @type {const} */ ('uuid'), formatted: trimmed, meta: [say('cellMetaChars', { count: trimmed.length })] };
  }
  const text = String(rawText ?? '');
  const lines = text ? text.split(/\r?\n/).length : 0;
  return {
    kind: /** @type {const} */ ('text'),
    formatted: text,
    meta: [say('cellMetaChars', { count: text.length }), say('cellMetaLines', { count: lines })],
  };
}

/**
 * Build an updated query string applying a quick cell filter (`=`, `!=`, `is empty`, `is not empty`).
 * @param {string} queryText
 * @param {string} tableId
 * @param {string} column
 * @param {string | null} value
 * @param {'=' | '!=' | 'empty' | 'not-empty'} op
 */
export function buildQuickCellFilter(queryText, tableId, column, value, op) {
  if (op === 'empty') return appendEqualityFilter(queryText, tableId, `${column} is empty`);
  if (op === 'not-empty') return appendEqualityFilter(queryText, tableId, `${column} is not empty`);
  const literal = quote(value ?? '');
  return appendEqualityFilter(queryText, tableId, `${column} ${op} ${literal}`);
}

/**
 * Read visible column headers and row cells from a rendered Workbench table grid.
 * @param {HTMLTableElement} tableEl
 */
export function extractVisibleGridData(tableEl) {
  const ths = [...tableEl.querySelectorAll('thead th')];
  const columns = ths.map((th) => {
    const col =
      th.getAttribute('data-column') ??
      th.querySelector('.th-filter[data-column]')?.getAttribute('data-column') ??
      th.querySelector('.th-label')?.textContent?.trim() ??
      th.textContent?.trim() ??
      '';
    return col.trim();
  });
  const keepIdx = columns.map((c, i) => (c && c !== '▸' ? i : -1)).filter((i) => i >= 0);
  const keptCols = keepIdx.map((i) => columns[i]);
  /** @type {unknown[][]} */
  const rows = [];
  for (const tr of tableEl.querySelectorAll('tbody tr')) {
    const tds = [...tr.querySelectorAll('td')];
    if (!tds.length) continue;
    rows.push(
      keepIdx.map((ci) => {
        const td = tds[ci];
        if (!td) return null;
        if (td.classList.contains('null') || td.querySelector('.null')) return null;
        const txt = td.textContent?.trim() ?? '';
        if (!txt) return '';
        const cleaned = txt.replace(/,/g, '');
        if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(cleaned) && Math.abs(Number(cleaned)) <= Number.MAX_SAFE_INTEGER) {
          return Number(cleaned);
        }
        return txt;
      }),
    );
  }
  return { columns: keptCols, rows };
}

/**
 * @param {{
 *   openShapeCheck: (tab?: import('./components/ShapeCheck.js').ShapeTab) => void;
 *   openAgentConsole?: () => void;
 *   openSql?: (sql?: string) => void;
 *   runQueryText?: (raw: string) => void;
 *   registerQueryObserver?: (fn: (raw: string) => void) => void;
 * }} actions
 */
export function initWorkbenchEnhancements({ openShapeCheck, openAgentConsole, runQueryText, registerQueryObserver }) {
  let filtersCollapsed = Boolean(loadJson(FILTER_COLLAPSED_KEY, false));
  shellBody().classList.toggle('wb-filters-collapsed', filtersCollapsed);

  /* Recent multi-token queries & breakdowns in ⌘K, shared across sibling environments. */
  registerQueryObserver?.((raw) => {
    if (!canUseDatabaseTools()) return;
    const connId = state.activeConnection ?? 'default';
    const { groupKey } = siblingGroupFor(connId);
    const store = /** @type {Record<string, string[]>} */ (loadJson(RECENT_QUERIES_KEY, {}));
    if (recordRecentQueryInStore(store, groupKey ?? connId, raw)) {
      saveJson(RECENT_QUERIES_KEY, store);
    }
  });

  addPaletteSource('places', () => {
    if (menuMode() !== 'workbench' || shell().inApp() || !canUseDatabaseTools() || !runQueryText) return [];
    const connId = state.activeConnection ?? 'default';
    const { groupKey, siblingIds } = siblingGroupFor(connId);
    const store = /** @type {Record<string, string[]>} */ (loadJson(RECENT_QUERIES_KEY, {}));
    const seen = new Set();
    const queries = [];
    for (const k of [groupKey, connId, ...siblingIds]) {
      if (!k || !Array.isArray(store[k])) continue;
      for (const q of store[k]) {
        if (typeof q !== 'string') continue;
        const low = q.toLowerCase();
        if (seen.has(low)) continue;
        seen.add(low);
        queries.push(q);
        if (queries.length >= MAX_RECENT_QUERIES) break;
      }
      if (queries.length >= MAX_RECENT_QUERIES) break;
    }
    return queries.map((q) => ({
      kind: 'filter',
      label: q,
      search: q,
      detail: say('recentQueryDetail'),
      run: () => {
        const qInput = /** @type {HTMLInputElement | null} */ (shellById('query'));
        if (qInput) qInput.value = q;
        runQueryText(q);
      },
    }));
  });

  /** @type {'all' | 'tables' | 'views'} */
  let sidebarKind = 'all';

  /** @type {Map<string, Record<string, string[]>>} */
  const redactedByConn = new Map();
  /** @type {Set<string>} */
  const redactedInflight = new Set();

  const ensureRedactedMap = (/** @type {string} */ connId) => {
    if (redactedByConn.has(connId) || redactedInflight.has(connId)) return;
    redactedInflight.add(connId);
    void api(`/api/connections/redacted?id=${encodeURIComponent(connId)}`)
      .then((res) => {
        redactedByConn.set(connId, res?.tables && typeof res.tables === 'object' ? res.tables : {});
        scheduleSync();
      })
      .catch(() => {
        redactedByConn.set(connId, {});
      })
      .finally(() => {
        redactedInflight.delete(connId);
      });
  };

  const applySidebarKind = (/** @type {'all' | 'tables' | 'views'} */ next) => {
    sidebarKind = next;
    const sidebar = shellQuery('.sidebar');
    if (!sidebar) return;
    if (next === 'all') delete sidebar.dataset.sidebarKind;
    else sidebar.dataset.sidebarKind = next;
    syncSidebarMeta();
  };

  const syncSidebarMeta = () => {
    const sidebar = shellQuery('.sidebar');
    const filterInput = shellById('table-filter');
    if (!sidebar || !filterInput || shell().inApp()) {
      shellById('wb-sidebar-meta')?.remove();
      return;
    }
    const tables = /** @type {Array<{ id: string; isView?: boolean }>} */ (state.schema?.tables ?? []);
    const viewCount = tables.filter((t) => Boolean(t.isView)).length;
    const tableCount = tables.length - viewCount;
    const activeConn = /** @type {Array<{ id: string; focused?: boolean }>} */ (state.connections ?? []).find(
      (c) => c.id === state.activeConnection,
    );
    const isFocused = Boolean(activeConn?.focused);

    if (viewCount === 0 && !isFocused) {
      shellById('wb-sidebar-meta')?.remove();
      delete sidebar.dataset.sidebarKind;
      return;
    }

    let host = shellById('wb-sidebar-meta');
    const tableListEl = shellById('table-list');
    if (!host && tableListEl) {
      host = document.createElement('div');
      host.id = 'wb-sidebar-meta';
      host.className = 'wb-sidebar-meta';
      tableListEl.insertAdjacentElement('beforebegin', host);
    }
    if (!host) return;

    host.replaceChildren();
    if (viewCount > 0) {
      const seg = document.createElement('div');
      seg.className = 'wb-sidebar-seg';
      seg.setAttribute('role', 'group');
      /** @type {Array<['all' | 'tables' | 'views', string, number]>} */
      const opts = [
        ['all', say('scopeAll'), tables.length],
        ['tables', say('scopeTables'), tableCount],
        ['views', say('scopeViews'), viewCount],
      ];
      for (const [kind, label, count] of opts) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.tabIndex = -1;
        btn.className = `wb-sidebar-seg-btn${sidebarKind === kind ? ' active' : ''}`;
        btn.setAttribute('aria-pressed', String(sidebarKind === kind));
        btn.addEventListener('click', () => applySidebarKind(kind));
        const text = document.createElement('span');
        text.textContent = label;
        const num = document.createElement('span');
        num.className = 'wb-sidebar-seg-count';
        num.textContent = String(count);
        btn.append(text, num);
        seg.append(btn);
      }
      host.append(seg);
    }

    if (isFocused) {
      const pill = document.createElement('span');
      pill.className = 'wb-sidebar-focus-pill';
      pill.textContent = say('focusedScope', { count: tables.length });
      host.append(pill);
    }
  };

  /* Typing or arrowing inside #table-filter resets to All so keyboard roving sees every row. */
  const filterBox = shellById('table-filter');
  if (filterBox) {
    filterBox.addEventListener('input', () => {
      if (sidebarKind !== 'all') applySidebarKind('all');
    });
    filterBox.addEventListener('keydown', (e) => {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && sidebarKind !== 'all') applySidebarKind('all');
    });
  }

  /* ---------- Inline Column Profile & Change Impact Popovers + Record Modals ---------- */

  const closeProfilePopover = () => {
    shellById('wb-col-profile-popover')?.remove();
    shellById('wb-col-impact-popover')?.remove();
    shellById('wb-record-modal')?.remove();
    shellById('wb-cell-inspector-popover')?.remove();
    shellById('wb-col-chooser-popover')?.remove();
    shellById('wb-copy-rows-popover')?.remove();
  };

  /**
   * Position and mount a lightweight floating popover clamped inside the viewport.
   * @param {HTMLElement} pop
   * @param {{ left: number; top: number; bottom: number }} anchorBox
   */
  const mountGridPopover = (pop, anchorBox) => {
    const view = viewportSize();
    pop.style.left = `${Math.max(12, Math.min(anchorBox.left, view.width - 360))}px`;
    pop.style.top = `${Math.max(12, Math.min(anchorBox.bottom + 6, view.height - 280))}px`;
    (portalRoot() ?? shellBody()).append(pop);
    const onOutside = (/** @type {MouseEvent} */ ev) => {
      if (!pop.isConnected) {
        removeHostListener(document, 'mousedown', onOutside, true);
        return;
      }
      if (!pop.contains(/** @type {Node} */ (ev.target))) {
        pop.remove();
        removeHostListener(document, 'mousedown', onOutside, true);
      }
    };
    const onEsc = (/** @type {KeyboardEvent} */ ev) => {
      if (!pop.isConnected) {
        removeHostListener(document, 'keydown', onEsc, true);
        return;
      }
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        pop.remove();
        removeHostListener(document, 'keydown', onEsc, true);
      }
    };
    window.setTimeout(() => {
      addHostListener(document, 'mousedown', onOutside, true);
      addHostListener(document, 'keydown', onEsc, true);
    }, 0);
  };

  /**
   * Open the Cell Inspector & Quick Cell Filter popover for a grid cell.
   * @param {HTMLTableCellElement} td
   * @param {string} colName
   * @param {string | null} tableId
   */
  const openCellInspector = (td, colName, tableId) => {
    closeProfilePopover();
    const isNull = td.classList.contains('null') || Boolean(td.querySelector('.null'));
    const rawText = isNull ? '' : (td.textContent ?? '');
    const info = inspectCellValue(rawText, isNull);

    const pop = document.createElement('div');
    pop.id = 'wb-cell-inspector-popover';
    pop.className = 'wb-grid-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', say('cellInspectorTitle', { column: colName }));

    const head = document.createElement('div');
    head.className = 'wb-grid-pop-head';
    const title = document.createElement('span');
    title.className = 'wb-grid-pop-title';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = say('cellInspectorTitle', { column: colName });
    const kindBadge = document.createElement('span');
    kindBadge.className = 'wb-cell-kind-badge';
    kindBadge.textContent =
      info.kind === 'json'
        ? say('cellKindJson')
        : info.kind === 'timestamp'
          ? say('cellKindTimestamp')
          : info.kind === 'uuid'
            ? say('cellKindUuid')
            : info.kind === 'null'
              ? say('cellKindNull')
              : say('cellKindText');
    title.append(nameSpan, kindBadge);
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'wb-col-profile-close';
    closeBtn.textContent = say('profileClose');
    closeBtn.addEventListener('click', () => pop.remove());
    head.append(title, closeBtn);
    pop.append(head);

    if (info.meta.length > 0) {
      const metaEl = document.createElement('div');
      metaEl.className = 'wb-cell-meta';
      for (const m of info.meta) {
        const s = document.createElement('span');
        s.textContent = m;
        metaEl.append(s);
      }
      pop.append(metaEl);
    }

    const pre = document.createElement('pre');
    pre.className = 'wb-cell-pre';
    pre.textContent = info.formatted;
    pop.append(pre);

    const actions = document.createElement('div');
    actions.className = 'wb-cell-actions';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'wb-pop-action';
    copyBtn.textContent = say('cellCopyValue');
    copyBtn.addEventListener('click', () => {
      void navigator.clipboard
        .writeText(info.formatted)
        .then(() => toast(say('cellCopiedToast'), 'ok'))
        .catch(() => toast(say('copyFailedToast'), 'bad'));
    });
    actions.append(copyBtn);

    if (tableId && runQueryText) {
      const entry = currentEntry();
      const baseQuery = typeof entry?.query === 'string' && entry.query.trim() ? entry.query : tableId;
      /** @type {Array<[string, '=' | '!=' | 'empty' | 'not-empty']>} */
      const filterOps = isNull
        ? [
            [say('cellFilterIsEmpty'), 'empty'],
            [say('cellFilterNotEmpty'), 'not-empty'],
          ]
        : [
            [say('cellFilterEquals'), '='],
            [say('cellFilterNotEquals'), '!='],
          ];
      for (const [label, op] of filterOps) {
        const fBtn = document.createElement('button');
        fBtn.type = 'button';
        fBtn.className = 'wb-pop-action';
        fBtn.textContent = label;
        fBtn.addEventListener('click', () => {
          const nextQ = buildQuickCellFilter(baseQuery, tableId, colName, isNull ? null : rawText.trim(), op);
          pop.remove();
          const qInput = /** @type {HTMLInputElement | null} */ (shellById('query'));
          if (qInput) qInput.value = nextQ;
          runQueryText(nextQ);
        });
        actions.append(fBtn);
      }
    }

    pop.append(actions);
    mountGridPopover(pop, viewportBox(td));
  };

  /**
   * Open the searchable Column Chooser / Jump-to-Column popover for a grid table.
   * @param {HTMLElement} anchorEl
   * @param {HTMLTableElement} gridTable
   * @param {string | null} tableId
   */
  const openColumnChooser = (anchorEl, gridTable, tableId) => {
    if (shellById('wb-col-chooser-popover')) {
      shellById('wb-col-chooser-popover')?.remove();
      return;
    }
    closeProfilePopover();
    const ths = [...gridTable.querySelectorAll('thead th')];
    const tableMeta = /** @type {Array<{ id: string; columns?: Array<{ name: string; type: string; primaryKey?: boolean }> }>} */ (
      state.schema?.tables ?? []
    ).find((t) => t.id === tableId);
    const items = ths
      .map((th) => {
        const name = (
          th.getAttribute('data-column') ??
          th.querySelector('.th-filter[data-column]')?.getAttribute('data-column') ??
          th.querySelector('.th-label')?.textContent ??
          th.textContent ??
          ''
        ).trim();
        const colMeta = tableMeta?.columns?.find((c) => c.name === name);
        return { name, th, type: colMeta?.type ?? '', pk: Boolean(colMeta?.primaryKey) };
      })
      .filter((x) => x.name && x.name !== '▸');

    const pop = document.createElement('div');
    pop.id = 'wb-col-chooser-popover';
    pop.className = 'wb-grid-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', say('columnsBtn'));

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'wb-col-search';
    search.placeholder = say('columnsSearchPlaceholder');
    search.setAttribute('aria-label', say('columnsSearchPlaceholder'));
    pop.append(search);

    const list = document.createElement('div');
    list.className = 'wb-col-list';
    pop.append(list);

    const renderList = (/** @type {string} */ needle) => {
      list.replaceChildren();
      const q = needle.trim().toLowerCase();
      const matched = q ? items.filter((it) => it.name.toLowerCase().includes(q) || it.type.toLowerCase().includes(q)) : items;
      if (!matched.length) {
        const empty = document.createElement('span');
        empty.className = 'wb-cell-meta';
        empty.textContent = say('columnsNoMatch');
        list.append(empty);
        return;
      }
      for (const it of matched) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wb-col-item';
        const left = document.createElement('span');
        left.textContent = it.name;
        const right = document.createElement('span');
        right.className = 'wb-col-type';
        right.textContent = it.pk && it.type ? say('colPkType', { type: it.type }) : it.type;
        btn.append(left, right);
        btn.addEventListener('click', () => {
          pop.remove();
          it.th.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
          it.th.classList.add('wb-th-flash');
          window.setTimeout(() => it.th.classList.remove('wb-th-flash'), 1200);
        });
        list.append(btn);
      }
    };

    search.addEventListener('input', () => renderList(search.value));
    renderList('');
    mountGridPopover(pop, viewportBox(anchorEl));
    search.focus();
  };

  /**
   * Open the Copy Rows As popover for visible grid rows.
   * @param {HTMLElement} anchorEl
   * @param {HTMLTableElement} gridTable
   * @param {string} tableName
   */
  const openCopyRowsPopover = (anchorEl, gridTable, tableName) => {
    if (shellById('wb-copy-rows-popover')) {
      shellById('wb-copy-rows-popover')?.remove();
      return;
    }
    closeProfilePopover();
    const { columns, rows } = extractVisibleGridData(gridTable);
    const pop = document.createElement('div');
    pop.id = 'wb-copy-rows-popover';
    pop.className = 'wb-grid-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', say('copyRowsBtn'));

    /** @type {Array<[import('../shared/sqlScript.js').ResultExportFormat, string, string]>} */
    const formats = [
      ['csv', say('copyAsCsv'), say('fmtCsv')],
      ['json', say('copyAsJson'), say('fmtJson')],
      ['markdown', say('copyAsMarkdown'), say('fmtMarkdown')],
      ['insert', say('copyAsInsert'), say('fmtInsert')],
      ['in', say('copyAsIn'), say('fmtIn')],
    ];
    for (const [fmt, label, shortName] of formats) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wb-pop-action';
      btn.textContent = label;
      btn.addEventListener('click', () => {
        const text = formatResultExport(columns, rows, fmt, tableName || 'table_name');
        pop.remove();
        void navigator.clipboard
          .writeText(text)
          .then(() => toast(say('copiedRowsToast', { count: rows.length, format: shortName }), 'ok'))
          .catch(() => toast(say('copyFailedToast'), 'bad'));
      });
      pop.append(btn);
    }
    mountGridPopover(pop, viewportBox(anchorEl));
  };

  /**
   * @param {HTMLElement} anchorEl
   * @param {string} tableId
   * @param {string} colName
   * @param {string} currentQuery
   */
  const openColumnProfile = (anchorEl, tableId, colName, currentQuery) => {
    closeProfilePopover();
    const box = viewportBox(anchorEl);
    const pop = document.createElement('div');
    pop.id = 'wb-col-profile-popover';
    pop.className = 'wb-col-profile-popover';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', colName);
    pop.style.top = `${Math.max(8, Math.round(box.bottom + 6))}px`;
    pop.style.left = `${Math.max(8, Math.min(Math.round(box.left), Math.max(8, viewportSize().width - 350)))}px`;

    const head = document.createElement('div');
    head.className = 'wb-col-profile-head';
    const title = document.createElement('span');
    title.className = 'wb-col-profile-title';
    title.textContent = `${tableId}.${colName}`;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'wb-col-profile-close';
    closeBtn.textContent = say('profileClose');
    closeBtn.addEventListener('click', closeProfilePopover);
    head.append(title, closeBtn);

    const body = document.createElement('div');
    body.textContent = say('profileLoading', { column: colName });
    pop.append(head, body);
    (portalRoot() ?? shellBody()).append(pop);

    void api('/api/agent/call', {
      name: 'profile',
      arguments: {
        ...(state.activeConnection ? { connection: state.activeConnection } : {}),
        table: tableId,
      },
    })
      .then((reply) => {
        if (!pop.isConnected) return;
        const sc = reply?.structuredContent ?? {};
        const cols = Array.isArray(sc.columns) ? sc.columns : [];
        const info = cols.find((c) => (c?.column ?? c?.name) === colName);
        if (reply?.isError || !info) {
          body.textContent = reply?.content?.[0]?.text ?? say('profileFailed');
          return;
        }
        body.replaceChildren();
        const metrics = document.createElement('div');
        metrics.className = 'wb-col-profile-metrics';
        const rowCount = Number(sc.rows ?? sc.rowCount ?? info.total ?? 0);
        const nullCount = Number(info.nullCount ?? 0);
        const nullPct =
          typeof info.nullFrac === 'number'
            ? Math.round(info.nullFrac * 100)
            : typeof info.nullFraction === 'number'
              ? Math.round(info.nullFraction * 100)
              : rowCount > 0
                ? Math.round((nullCount / rowCount) * 100)
                : 0;

        const addMetric = (/** @type {string} */ text) => {
          const span = document.createElement('span');
          span.className = 'wb-col-profile-metric';
          span.textContent = text;
          metrics.append(span);
        };
        addMetric(say('profileNullPct', { pct: nullPct }));
        if (info.distinct !== undefined && info.distinct !== null) {
          addMetric(say('profileDistinct', { count: formatNumber(Number(info.distinct)) }));
        }
        if (
          info.min !== undefined &&
          info.min !== null &&
          info.max !== undefined &&
          info.max !== null &&
          String(info.min) !== String(info.max)
        ) {
          addMetric(say('profileRange', { min: String(info.min), max: String(info.max) }));
        }
        if (rowCount > 0 || typeof info.nullFrac === 'number' || typeof info.nullFraction === 'number') {
          const fillBar = document.createElement('div');
          fillBar.className = 'wb-col-profile-fill';
          fillBar.setAttribute('aria-hidden', 'true');
          const present = document.createElement('span');
          present.className = 'wb-col-profile-fill-present';
          present.style.width = `${Math.max(0, Math.min(100, 100 - nullPct))}%`;
          fillBar.append(present);
          body.append(fillBar);
        }
        body.append(metrics);

        const top = Array.isArray(info.common ?? info.topValues ?? info.top) ? (info.common ?? info.topValues ?? info.top) : [];
        if (top.length > 0 && runQueryText) {
          const topLabel = document.createElement('div');
          topLabel.className = 'wb-col-profile-top-label';
          topLabel.textContent = say('profileTopValues');
          const chips = document.createElement('div');
          chips.className = 'wb-col-profile-chips';
          const entries = top
            .slice(0, 6)
            .filter((item) => item?.value !== null && item?.value !== undefined)
            .map((item) => {
              const valText = String(item.value);
              const estCount =
                item?.count !== undefined
                  ? Number(item.count)
                  : typeof item?.frac === 'number' && rowCount > 0
                    ? Math.max(1, Math.round(item.frac * rowCount))
                    : undefined;
              const weight =
                estCount !== undefined && Number.isFinite(estCount)
                  ? estCount
                  : typeof item?.frac === 'number' && Number.isFinite(item.frac)
                    ? item.frac
                    : 0;
              return { valText, estCount, weight };
            });
          const weights = entries.map((e) => e.weight).filter((w) => w > 0);
          const scale = weights.length
            ? valueScale(
                {
                  min: 0,
                  max: Math.max(extentOf(weights, 0).max, 1),
                },
                { intervals: 4 },
              )
            : null;
          const zeroAt = scale ? scale.share(0) * 100 : 0;
          for (const { valText, estCount, weight } of entries) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'wb-col-profile-chip';
            if (scale && weight > 0) {
              const span = barSpan(scale.share(weight) * 100, zeroAt, 2);
              const bar = document.createElement('span');
              bar.className = 'wb-col-profile-bar';
              bar.setAttribute('aria-hidden', 'true');
              bar.style.width = `${Math.max(0, Math.min(100, span.length))}%`;
              chip.append(bar);
            }
            const vSpan = document.createElement('span');
            vSpan.className = 'wb-col-profile-chip-val';
            vSpan.textContent = valText.length > 28 ? `${valText.slice(0, 28)}…` : valText;
            chip.append(vSpan);
            if (estCount !== undefined) {
              const cSpan = document.createElement('span');
              cSpan.className = 'wb-col-profile-chip-count';
              cSpan.textContent = estCount >= 10_000 ? formatChartNumber(estCount) : formatNumber(estCount);
              chip.append(cSpan);
            }
            chip.addEventListener('click', () => {
              closeProfilePopover();
              const nextQ = appendEqualityFilter(currentQuery, tableId, `${colName} = ${quote(valText.trim())}`);
              const qInput = /** @type {HTMLInputElement | null} */ (shellById('query'));
              if (qInput) qInput.value = nextQ;
              runQueryText(nextQ);
            });
            chips.append(chip);
          }
          if (chips.childElementCount > 0) body.append(topLabel, chips);
        }
      })
      .catch(() => {
        if (pop.isConnected) body.textContent = say('profileFailed');
      });
  };

  /**
   * @param {HTMLElement} anchorEl
   * @param {string} tableId
   * @param {string} colName
   */
  const openChangeImpact = (anchorEl, tableId, colName) => {
    closeProfilePopover();
    const box = viewportBox(anchorEl);
    const pop = document.createElement('div');
    pop.id = 'wb-col-impact-popover';
    pop.className = 'wb-col-profile-popover';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', colName);
    pop.style.top = `${Math.max(8, Math.round(box.bottom + 6))}px`;
    pop.style.left = `${Math.max(8, Math.min(Math.round(box.left), Math.max(8, viewportSize().width - 370)))}px`;

    const head = document.createElement('div');
    head.className = 'wb-col-profile-head';
    const title = document.createElement('span');
    title.className = 'wb-col-profile-title';
    title.textContent = `${tableId}.${colName}`;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'wb-col-profile-close';
    closeBtn.textContent = say('profileClose');
    closeBtn.addEventListener('click', closeProfilePopover);
    head.append(title, closeBtn);

    const body = document.createElement('div');
    body.textContent = say('impactLoading', { column: colName });
    pop.append(head, body);
    (portalRoot() ?? shellBody()).append(pop);

    void api('/api/agent/call', {
      name: 'change_impact',
      arguments: {
        ...(state.activeConnection ? { connection: state.activeConnection } : {}),
        table: tableId,
        column: colName,
      },
    })
      .then((reply) => {
        if (!pop.isConnected) return;
        const sc = reply?.structuredContent;
        if (reply?.isError || !sc) {
          body.textContent = reply?.content?.[0]?.text ?? say('impactFailed');
          return;
        }
        body.replaceChildren();
        const metrics = document.createElement('div');
        metrics.className = 'wb-col-profile-metrics';
        const addMetric = (/** @type {string} */ text) => {
          const span = document.createElement('span');
          span.className = 'wb-col-profile-metric';
          span.textContent = text;
          metrics.append(span);
        };
        if (sc.rows !== undefined && sc.rows !== null) {
          addMetric(say('impactRowsMetric', { count: formatNumber(Number(sc.rows)) }));
        }
        const facts = sc.columnFacts ?? {};
        if (facts.nulls !== undefined && facts.nulls !== null) {
          addMetric(say('impactNullsMetric', { count: formatNumber(Number(facts.nulls)) }));
        }
        if (facts.indexed !== undefined && facts.indexed !== null) {
          addMetric(facts.indexed ? say('impactIndexedMetric') : say('impactUnindexedMetric'));
        }
        if (metrics.childElementCount > 0) body.append(metrics);

        const refs = Array.isArray(sc.referencedBy) ? sc.referencedBy : [];
        if (refs.length > 0) {
          const rHead = document.createElement('div');
          rHead.className = 'wb-col-profile-top-label';
          rHead.textContent = say('impactRefsHeading');
          const rList = document.createElement('div');
          rList.className = 'wb-col-impact-list';
          for (const dep of refs.slice(0, 5)) {
            const item = document.createElement('div');
            item.className = 'wb-col-impact-item';
            const cols = Array.isArray(dep.columns) ? dep.columns.join(', ') : '';
            const countPart = dep.rows !== undefined ? ` · ${formatNumber(Number(dep.rows))}` : '';
            const rulePart = dep.onDelete ? ` · ${dep.onDelete}` : '';
            item.textContent = `${dep.table}.${cols}${countPart}${rulePart}`;
            rList.append(item);
          }
          body.append(rHead, rList);
        }

        const notes = Array.isArray(sc.notes) ? sc.notes : [];
        if (notes.length > 0) {
          const nHead = document.createElement('div');
          nHead.className = 'wb-col-profile-top-label';
          nHead.textContent = say('impactConsequencesHeading');
          const nList = document.createElement('div');
          nList.className = 'wb-col-impact-list';
          for (const note of notes.slice(0, 4)) {
            const item = document.createElement('div');
            item.className = 'wb-col-impact-item';
            item.textContent = String(note);
            nList.append(item);
          }
          body.append(nHead, nList);
        }
      })
      .catch(() => {
        if (pop.isConnected) body.textContent = say('impactFailed');
      });
  };

  /**
   * @param {string} tableId
   * @param {Record<string, unknown>} recordKey
   */
  const openRecordFixtureModal = (tableId, recordKey) => {
    closeProfilePopover();
    const activeConn = /** @type {Array<{ id: string; redactsRows?: boolean }>} */ (state.connections ?? []).find(
      (c) => c.id === state.activeConnection,
    );
    let includeChildren = true;
    let maskPii = Boolean(activeConn?.redactsRows);
    /** @type {'sql' | 'json'} */
    let format = 'sql';
    /** @type {{ sql: string; tables: Array<{ table: string; rows: unknown[] }> } | null} */
    let latestData = null;

    const backdrop = document.createElement('div');
    backdrop.id = 'wb-record-modal';
    backdrop.className = 'wb-modal-backdrop';
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeProfilePopover();
    });

    const card = document.createElement('div');
    card.className = 'wb-modal-card';
    card.setAttribute('role', 'dialog');
    const titleText = say('fixtureModalTitle', { table: tableId });
    card.setAttribute('aria-label', titleText);

    const head = document.createElement('div');
    head.className = 'wb-modal-head';
    const h2 = document.createElement('h2');
    h2.className = 'wb-modal-title';
    h2.textContent = titleText;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'wb-col-profile-close';
    closeBtn.textContent = say('profileClose');
    closeBtn.addEventListener('click', closeProfilePopover);
    head.append(h2, closeBtn);

    const toolbar = document.createElement('div');
    toolbar.className = 'wb-fixture-toolbar';

    const checks = document.createElement('div');
    checks.className = 'wb-fixture-checks';

    const childLabel = document.createElement('label');
    childLabel.className = 'wb-fixture-check';
    const childInput = document.createElement('input');
    childInput.type = 'checkbox';
    childInput.checked = includeChildren;
    const childSpan = document.createElement('span');
    childSpan.textContent = say('fixtureIncludeChildren');
    childLabel.append(childInput, childSpan);

    const maskLabel = document.createElement('label');
    maskLabel.className = 'wb-fixture-check';
    const maskInput = document.createElement('input');
    maskInput.type = 'checkbox';
    maskInput.checked = maskPii;
    const maskSpan = document.createElement('span');
    maskSpan.textContent = say('fixtureMaskPii');
    maskLabel.append(maskInput, maskSpan);

    const statsSpan = document.createElement('span');
    statsSpan.style.color = 'var(--ink-subtle)';
    checks.append(childLabel, maskLabel, statsSpan);

    const actions = document.createElement('div');
    actions.className = 'wb-fixture-actions';
    const seg = document.createElement('div');
    seg.className = 'wb-sidebar-seg';
    const sqlFmtBtn = document.createElement('button');
    sqlFmtBtn.type = 'button';
    sqlFmtBtn.className = 'wb-sidebar-seg-btn active';
    sqlFmtBtn.textContent = say('fixtureFormatSql');
    const jsonFmtBtn = document.createElement('button');
    jsonFmtBtn.type = 'button';
    jsonFmtBtn.className = 'wb-sidebar-seg-btn';
    jsonFmtBtn.textContent = say('fixtureFormatJson');
    seg.append(sqlFmtBtn, jsonFmtBtn);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'wb-col-profile-close';
    copyBtn.textContent = say('fixtureCopyBtn');
    actions.append(seg, copyBtn);
    toolbar.append(checks, actions);

    const pre = document.createElement('pre');
    pre.className = 'wb-fixture-pre';
    pre.textContent = say('fixtureLoading');

    const renderOutput = () => {
      sqlFmtBtn.classList.toggle('active', format === 'sql');
      jsonFmtBtn.classList.toggle('active', format === 'json');
      if (!latestData) return;
      pre.textContent = format === 'sql' ? latestData.sql : JSON.stringify({ tables: latestData.tables }, null, 2);
    };

    sqlFmtBtn.addEventListener('click', () => {
      format = 'sql';
      renderOutput();
    });
    jsonFmtBtn.addEventListener('click', () => {
      format = 'json';
      renderOutput();
    });
    copyBtn.addEventListener('click', () => {
      if (!latestData) return;
      const text = format === 'sql' ? latestData.sql : JSON.stringify({ tables: latestData.tables }, null, 2);
      void navigator.clipboard?.writeText(text).then(() => {
        copyBtn.textContent = say('fixtureCopiedBtn');
        window.setTimeout(() => {
          if (copyBtn.isConnected) copyBtn.textContent = say('fixtureCopyBtn');
        }, 1500);
      });
    });

    let reqSeq = 0;
    const loadFixture = () => {
      const seq = ++reqSeq;
      latestData = null;
      statsSpan.textContent = '';
      pre.textContent = say('fixtureLoading');
      void api('/api/agent/call', {
        name: 'fixture',
        arguments: {
          ...(state.activeConnection ? { connection: state.activeConnection } : {}),
          table: tableId,
          key: recordKey,
          children: includeChildren,
          redact: maskPii,
        },
      })
        .then((reply) => {
          if (!backdrop.isConnected || seq !== reqSeq) return;
          const sc = reply?.structuredContent;
          if (reply?.isError || !sc || typeof sc.sql !== 'string') {
            pre.textContent = reply?.content?.[0]?.text ?? say('fixtureFailed');
            return;
          }
          const tablesArr = Array.isArray(sc.tables) ? sc.tables : [];
          const rowTotal = tablesArr.reduce((sum, t) => sum + (Array.isArray(t.rows) ? t.rows.length : 0), 0);
          statsSpan.textContent = say('fixtureStats', { count: rowTotal, tables: tablesArr.length });
          latestData = { sql: sc.sql, tables: tablesArr };
          renderOutput();
        })
        .catch(() => {
          if (backdrop.isConnected && seq === reqSeq) pre.textContent = say('fixtureFailed');
        });
    };

    childInput.addEventListener('change', () => {
      includeChildren = childInput.checked;
      loadFixture();
    });
    maskInput.addEventListener('change', () => {
      maskPii = maskInput.checked;
      loadFixture();
    });

    card.append(head, toolbar, pre);
    backdrop.append(card);
    (portalRoot() ?? shellBody()).append(backdrop);
    loadFixture();
  };

  /**
   * @param {string} tableId
   * @param {Record<string, unknown>} recordKey
   */
  const openRecordCompareModal = (tableId, recordKey) => {
    closeProfilePopover();
    const backdrop = document.createElement('div');
    backdrop.id = 'wb-record-modal';
    backdrop.className = 'wb-modal-backdrop';
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeProfilePopover();
    });

    const card = document.createElement('div');
    card.className = 'wb-modal-card';
    card.setAttribute('role', 'dialog');
    const titleText = say('compareRecordModalTitle', { table: tableId });
    card.setAttribute('aria-label', titleText);

    const head = document.createElement('div');
    head.className = 'wb-modal-head';
    const h2 = document.createElement('h2');
    h2.className = 'wb-modal-title';
    h2.textContent = titleText;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'wb-col-profile-close';
    closeBtn.textContent = say('profileClose');
    closeBtn.addEventListener('click', closeProfilePopover);
    head.append(h2, closeBtn);

    const body = document.createElement('div');
    body.textContent = say('compareRecordLoading');
    card.append(head, body);
    backdrop.append(card);
    (portalRoot() ?? shellBody()).append(backdrop);

    void api('/api/agent/call', {
      name: 'record',
      arguments: {
        ...(state.activeConnection ? { connection: state.activeConnection } : {}),
        table: tableId,
        key: recordKey,
        envs: 'all',
      },
    })
      .then((reply) => {
        if (!backdrop.isConnected) return;
        const envs = reply?.structuredContent?.environments;
        if (reply?.isError || !Array.isArray(envs) || !envs.length) {
          body.textContent = reply?.content?.[0]?.text ?? say('compareRecordFailed');
          return;
        }
        body.replaceChildren();
        const wrap = document.createElement('div');
        wrap.className = 'wb-compare-wrap';
        const tbl = document.createElement('table');
        tbl.className = 'wb-compare-table';

        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        const fieldTh = document.createElement('th');
        fieldTh.textContent = say('compareFieldCol');
        headRow.append(fieldTh);
        for (const envEntry of envs) {
          const th = document.createElement('th');
          th.textContent = envEntry.env ? `${envEntry.name} (${envEntry.env})` : String(envEntry.name ?? envEntry.connection);
          headRow.append(th);
        }
        thead.append(headRow);

        const schemaCols =
          /** @type {Array<{ id: string; name: string; columns?: Array<{ name: string }> }>} */ (state.schema?.tables ?? [])
            .find((t) => t.id === tableId || t.name === tableId)
            ?.columns?.map((c) => c.name) ?? [];
        const colSet = new Set(schemaCols);
        for (const envEntry of envs) {
          const rowObj = envEntry?.result?.row;
          if (rowObj && typeof rowObj === 'object') {
            for (const k of Object.keys(rowObj)) colSet.add(k);
          }
        }

        const tbody = document.createElement('tbody');
        for (const col of colSet) {
          const tr = document.createElement('tr');
          tr.className = 'wb-compare-row';
          const serialized = envs.map((envEntry) => {
            if (!envEntry.ok || !envEntry.result?.found) return '__MISSING_ROW__';
            const val = envEntry.result.row?.[col];
            return val === undefined ? 'null' : JSON.stringify(val);
          });
          const isDiff = new Set(serialized).size > 1;
          if (isDiff) tr.classList.add('is-diff');

          const nameTd = document.createElement('td');
          nameTd.textContent = col;
          if (isDiff) {
            const diffBadge = document.createElement('span');
            diffBadge.className = 'wb-masked-col-pill';
            diffBadge.textContent = say('compareDiffBadge');
            nameTd.append(diffBadge);
          }
          tr.append(nameTd);

          for (const envEntry of envs) {
            const td = document.createElement('td');
            if (!envEntry.ok || !envEntry.result?.found) {
              const span = document.createElement('span');
              span.className = 'wb-compare-missing';
              span.textContent = !envEntry.ok && envEntry.error ? String(envEntry.error) : say('compareMissingRow');
              td.append(span);
            } else {
              const val = envEntry.result.row?.[col];
              if (val === null || val === undefined) {
                const span = document.createElement('span');
                span.className = 'wb-compare-missing';
                span.textContent = 'null';
                td.append(span);
              } else {
                td.textContent = typeof val === 'object' ? JSON.stringify(val) : String(val);
              }
            }
            tr.append(td);
          }
          tbody.append(tr);
        }
        tbl.append(thead, tbody);
        wrap.append(tbl);
        body.append(wrap);
      })
      .catch(() => {
        if (backdrop.isConnected) body.textContent = say('compareRecordFailed');
      });
  };

  addHostListener(document, 'keydown', (e) => {
    if (e.key === 'Escape') closeProfilePopover();
  });

  /* ---------- Enhance `.th-menu` with Profile column, Change impact & 1-click FK dot-path pull ---------- */

  /** @type {HTMLElement | null} */
  let lastThFilterAnchor = null;
  /** @type {string | null} */
  let lastThColName = null;

  addHostListener(
    document,
    'click',
    (e) => {
      const btn = e.target instanceof Element ? e.target.closest('.th-filter') : null;
      if (btn instanceof HTMLElement) {
        lastThFilterAnchor = btn;
        lastThColName = btn.getAttribute('data-column') || btn.closest('th')?.querySelector('.th-label')?.textContent?.trim() || null;
      }
    },
    true,
  );

  const dismissMenu = (/** @type {HTMLElement} */ menu) => {
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  };

  const enhanceColumnMenus = () => {
    if (shell().inApp() || !state.schema) return;
    const menus = shellQueryAll('.th-menu');
    for (const menu of menus) {
      if (!(menu instanceof HTMLElement) || menu.dataset.wbEnhanced === '1') continue;
      const expandedAnchor = /** @type {HTMLElement | null} */ (shellQuery('.th-filter[aria-expanded="true"]'));
      const anchor = expandedAnchor ?? (lastThFilterAnchor?.isConnected ? lastThFilterAnchor : null);
      const sortCondText = menu.querySelector('.th-menu-cond')?.textContent?.trim() ?? '';
      const sortMatch = /^sort\s+(\S+)/i.exec(sortCondText);
      const colName = expandedAnchor?.getAttribute('data-column') || lastThColName || (sortMatch ? sortMatch[1] : null);
      const entry = currentEntry();
      if (!anchor || !colName || !entry || entry.kind !== 'table') continue;
      const tableMeta = /** @type {Array<{ id: string; name: string; columns: Array<{ name: string; primaryKey?: boolean }> }>} */ (
        state.schema.tables ?? []
      ).find((t) => t.id === entry.table || t.name === entry.table);
      if (!tableMeta) continue;
      menu.dataset.wbEnhanced = '1';

      const sep = document.createElement('div');
      sep.className = 'th-menu-sep';
      sep.setAttribute('role', 'separator');

      const profileBtn = document.createElement('button');
      profileBtn.type = 'button';
      profileBtn.className = 'th-menu-item';
      profileBtn.setAttribute('role', 'menuitem');
      const pLabel = document.createElement('span');
      pLabel.className = 'th-menu-label';
      pLabel.textContent = say('profileColumn');
      const pSub = document.createElement('span');
      pSub.className = 'th-menu-cond';
      pSub.textContent = say('profileColumnSub');
      profileBtn.append(pLabel, pSub);
      profileBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const queryNow = entry.query ?? tableMeta.id;
        dismissMenu(menu);
        window.setTimeout(() => openColumnProfile(anchor, tableMeta.id, colName, queryNow), 30);
      });

      const impactBtn = document.createElement('button');
      impactBtn.type = 'button';
      impactBtn.className = 'th-menu-item';
      impactBtn.setAttribute('role', 'menuitem');
      const iLabel = document.createElement('span');
      iLabel.className = 'th-menu-label';
      iLabel.textContent = say('changeImpact');
      const iSub = document.createElement('span');
      iSub.className = 'th-menu-cond';
      iSub.textContent = say('changeImpactSub');
      impactBtn.append(iLabel, iSub);
      impactBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        dismissMenu(menu);
        window.setTimeout(() => openChangeImpact(anchor, tableMeta.id, colName), 30);
      });

      menu.append(sep, profileBtn, impactBtn);

      /* Foreign-key 1-click column pull (`+ Show customer_id.name`) */
      const fks = /** @type {Array<{ from: { table: string; columns: string[] }; to: { table: string; columns: string[] } }>} */ (
        state.schema.foreignKeys ?? []
      );
      const fk = fks.find(
        (f) =>
          (f.from.table === tableMeta.id || f.from.table === tableMeta.name) &&
          f.from.columns.length === 1 &&
          f.from.columns[0] === colName,
      );
      if (fk && runQueryText) {
        const targetMeta = /** @type {Array<{ id: string; name: string; columns: Array<{ name: string; primaryKey?: boolean }> }>} */ (
          state.schema.tables ?? []
        ).find((t) => t.id === fk.to.table || t.name === fk.to.table);
        if (targetMeta) {
          const candidates = targetMeta.columns
            .filter((c) => !c.primaryKey)
            .sort((a, b) => {
              const score = (/** @type {string} */ n) => (/^(name|title|label|display_name|code|email|status)$/i.test(n) ? 0 : 1);
              return score(a.name) - score(b.name);
            })
            .slice(0, 4);
          if (candidates.length > 0) {
            const head = document.createElement('div');
            head.className = 'wb-th-section-head';
            head.textContent = say('showFromTarget', { table: targetMeta.name });
            menu.append(head);
            const baseColNames = tableMeta.columns.map((c) => c.name);
            for (const targetCol of candidates) {
              const dotPath = `${colName}.${targetCol.name}`;
              const pullBtn = document.createElement('button');
              pullBtn.type = 'button';
              pullBtn.className = 'th-menu-item';
              pullBtn.setAttribute('role', 'menuitem');
              const lSpan = document.createElement('span');
              lSpan.className = 'th-menu-label';
              lSpan.textContent = `+ ${dotPath}`;
              const cSpan = document.createElement('span');
              cSpan.className = 'th-menu-cond';
              cSpan.textContent = say('pullFkSub');
              pullBtn.append(lSpan, cSpan);
              pullBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const nextQ = appendShowProjection(entry.query ?? tableMeta.id, tableMeta.id, baseColNames, dotPath);
                dismissMenu(menu);
                const qInput = /** @type {HTMLInputElement | null} */ (shellById('query'));
                if (qInput) qInput.value = nextQ;
                runQueryText(nextQ);
              });
              menu.append(pullBtn);
            }
          }
        }
      }
    }
  };

  /* ---------- Per-column `masked` badges, Compiled-SQL `Plan` button & Record actions ---------- */

  let lastCompiledSql = '';

  const syncContentPolish = () => {
    if (shell().inApp()) return;

    /* 1. Table room quick-filter collapse toggle inside `.tabs` */
    const tabs = shellQuery('.grid-host .tabs');
    const filterBar = shellQuery('.grid-host + .host-contents > .applist-filterbar');
    const existingToggle = shellById('wb-filter-toggle');
    if (tabs && filterBar) {
      const clauseCount = shellQueryAll('.clauses .clause').length;
      const open = !shellBody().classList.contains('wb-filters-collapsed');
      let btn = /** @type {HTMLButtonElement | null} */ (existingToggle);
      if (!btn) {
        btn = document.createElement('button');
        btn.id = 'wb-filter-toggle';
        btn.type = 'button';
        btn.tabIndex = -1;
        btn.title = say('toggleQuickFilters');
        btn.addEventListener('click', () => {
          filtersCollapsed = !shellBody().classList.contains('wb-filters-collapsed');
          shellBody().classList.toggle('wb-filters-collapsed', filtersCollapsed);
          saveJson(FILTER_COLLAPSED_KEY, filtersCollapsed);
          syncContentPolish();
        });
        const lastBtn = tabs.querySelector(':scope > button:not(.tab):last-of-type');
        if (lastBtn) tabs.insertBefore(btn, lastBtn);
        else tabs.append(btn);
      }
      btn.className = `wb-filter-toggle${open ? ' is-open' : ''}`;
      btn.setAttribute('aria-expanded', String(open));
      btn.textContent = !open && clauseCount > 0 ? say('filtersToggleCount', { count: clauseCount }) : say('filtersToggle');
    } else if (existingToggle) {
      existingToggle.remove();
    }

    /* 1b. Table room ergonomics: searchable Columns jump popover, Copy Rows As… menu, & visible numeric aggregates footer */
    const gridTable = /** @type {HTMLTableElement | null} */ (shellQuery('#content .result-table table, #content .grid-host table'));
    const gridContainer = gridTable?.closest('.result-table') ?? gridTable?.closest('.grid-host') ?? null;
    const activeTableEntry = currentEntry();
    const activeTableId = typeof activeTableEntry?.table === 'string' ? activeTableEntry.table : null;
    if (tabs && gridTable && gridTable.querySelector('thead th')) {
      if (!shellById('wb-col-chooser-btn')) {
        const colBtn = document.createElement('button');
        colBtn.id = 'wb-col-chooser-btn';
        colBtn.type = 'button';
        colBtn.tabIndex = -1;
        colBtn.className = 'wb-filter-toggle';
        colBtn.title = say('columnsBtnTitle');
        colBtn.textContent = say('columnsBtn');
        colBtn.addEventListener('click', () => {
          const latestTable = /** @type {HTMLTableElement | null} */ (
            shellQuery('#content .result-table table, #content .grid-host table')
          );
          const latestEntry = currentEntry();
          if (latestTable) {
            openColumnChooser(colBtn, latestTable, typeof latestEntry?.table === 'string' ? latestEntry.table : null);
          }
        });
        const anchor = shellById('wb-filter-toggle') ?? tabs.querySelector(':scope > button:not(.tab):last-of-type');
        if (anchor) anchor.insertAdjacentElement('afterend', colBtn);
        else tabs.append(colBtn);
      }
      if (!shellById('wb-copy-rows-btn')) {
        const copyBtn = document.createElement('button');
        copyBtn.id = 'wb-copy-rows-btn';
        copyBtn.type = 'button';
        copyBtn.tabIndex = -1;
        copyBtn.className = 'wb-filter-toggle';
        copyBtn.title = say('copyRowsBtnTitle');
        copyBtn.textContent = say('copyRowsBtn');
        copyBtn.addEventListener('click', () => {
          const latestTable = /** @type {HTMLTableElement | null} */ (
            shellQuery('#content .result-table table, #content .grid-host table')
          );
          const latestEntry = currentEntry();
          if (latestTable) {
            openCopyRowsPopover(copyBtn, latestTable, typeof latestEntry?.table === 'string' ? latestEntry.table : 'rows');
          }
        });
        const anchor = shellById('wb-col-chooser-btn') ?? tabs.querySelector(':scope > button:not(.tab):last-of-type');
        if (anchor) anchor.insertAdjacentElement('afterend', copyBtn);
        else tabs.append(copyBtn);
      }

      const { columns, rows } = extractVisibleGridData(gridTable);
      const aggs = rows.length >= 2 ? computeColumnAggregates(columns, rows).slice(0, 4) : [];
      const existingAgg = shellById('wb-grid-agg-footer');
      if (aggs.length > 0 && gridContainer) {
        const sig = `${activeTableId ?? ''}:${rows.length}:${aggs.map((a) => `${a.column}=${a.sum}`).join('|')}`;
        if (!existingAgg || existingAgg.dataset.wbAggSig !== sig) {
          const footer = existingAgg ?? document.createElement('div');
          footer.id = 'wb-grid-agg-footer';
          footer.className = 'wb-grid-agg-footer';
          footer.dataset.wbAggSig = sig;
          footer.replaceChildren();
          for (const agg of aggs) {
            const span = document.createElement('span');
            span.textContent = say('gridAggItem', {
              col: agg.column,
              sum: formatChartNumber(agg.sum),
              avg: formatChartNumber(agg.avg),
              min: formatChartNumber(agg.min),
              max: formatChartNumber(agg.max),
            });
            footer.append(span);
          }
          if (!footer.isConnected) gridContainer.append(footer);
        }
      } else {
        existingAgg?.remove();
      }
    } else {
      shellById('wb-col-chooser-btn')?.remove();
      shellById('wb-copy-rows-btn')?.remove();
      shellById('wb-grid-agg-footer')?.remove();
    }

    /* 2. Compiled-SQL `#explain-pane` inline `Plan` button */
    const explainPane = shellById('explain-pane');
    const explainPre = shellById('explain');
    const explainEdit = shellById('explain-edit');
    const activeConn = /** @type {Array<{ id: string; redactsRows?: boolean; hidesColumns?: boolean; siblings?: unknown[] }>} */ (
      state.connections ?? []
    ).find((c) => c.id === state.activeConnection);
    const canExplain = !activeConn?.redactsRows && !activeConn?.hidesColumns;

    if (explainPane && explainPre && explainEdit && !explainPane.hidden && canExplain) {
      const currentSql = explainPre.textContent?.trim() ?? '';
      if (currentSql !== lastCompiledSql) {
        lastCompiledSql = currentSql;
        shellById('wb-inline-plan')?.remove();
      }
      if (!shellById('wb-explain-plan-btn')) {
        const planBtn = document.createElement('button');
        planBtn.id = 'wb-explain-plan-btn';
        planBtn.type = 'button';
        planBtn.tabIndex = -1;
        planBtn.className = 'wb-explain-plan-btn';
        planBtn.title = say('explainPlanTitle');
        planBtn.textContent = say('explainPlanBtn');
        planBtn.addEventListener('click', () => {
          const existing = shellById('wb-inline-plan');
          if (existing) {
            existing.remove();
            return;
          }
          const sqlText = explainPre.textContent?.trim() ?? '';
          if (!sqlText) return;
          void api('/api/agent/call', {
            name: 'explain',
            arguments: {
              ...(state.activeConnection ? { connection: state.activeConnection } : {}),
              statement: sqlText,
            },
          })
            .then((reply) => {
              const lines = reply?.structuredContent?.plan;
              if (!Array.isArray(lines) || !lines.length) return;
              shellById('wb-inline-plan')?.remove();
              const host = document.createElement('div');
              host.id = 'wb-inline-plan';
              host.className = 'wb-inline-plan';
              explainPane.style.flexWrap = 'wrap';
              for (const line of lines) {
                const text = String(line);
                const isIdx =
                  /\b(?:Index(?: Only)? Scan|Bitmap Index Scan)\b/i.test(text) ||
                  /\bUSING\s+(?:COVERING\s+)?INDEX\b/i.test(text) ||
                  /\bUSING\s+INTEGER\s+PRIMARY\s+KEY\b/i.test(text);
                const isSeq = !isIdx && (/\bSeq Scan\b/i.test(text) || /^SCAN\s+/i.test(text) || /\bSCAN TABLE\b/i.test(text));
                const row = document.createElement('div');
                row.className = `wb-inline-plan-row${isSeq ? ' tone-warn' : isIdx ? ' tone-ok' : ''}`;
                const s = document.createElement('span');
                s.textContent = text;
                row.append(s);
                if (isSeq || isIdx) {
                  const tag = document.createElement('span');
                  tag.className = 'wb-inline-plan-tag';
                  tag.textContent = isSeq ? say('seqScanBadge') : say('indexSeekBadge');
                  row.append(tag);
                }
                host.append(row);
              }
              explainPane.append(host);
            })
            .catch(() => {});
        });
        explainEdit.insertAdjacentElement('beforebegin', planBtn);
      }
    } else {
      shellById('wb-explain-plan-btn')?.remove();
      shellById('wb-inline-plan')?.remove();
    }

    /* 2b. Record view actions: 1-click `Extract fixture…` & cross-environment `Compare envs` */
    const curEntry = currentEntry();
    const recordHeading = shellQuery('.record-heading');
    const recordAsPage = recordHeading?.querySelector('.record-as-page');
    if (curEntry?.kind === 'row' && curEntry.table && curEntry.key && recordHeading && recordAsPage && canUseDatabaseTools()) {
      if (!shellById('wb-extract-fixture-btn')) {
        const fixBtn = document.createElement('button');
        fixBtn.id = 'wb-extract-fixture-btn';
        fixBtn.type = 'button';
        fixBtn.tabIndex = -1;
        fixBtn.className = 'ghost';
        fixBtn.title = say('extractFixtureTitle');
        fixBtn.textContent = say('extractFixtureBtn');
        fixBtn.addEventListener('click', () => {
          const latest = currentEntry();
          if (latest?.kind === 'row' && latest.table && latest.key) {
            openRecordFixtureModal(latest.table, /** @type {Record<string, unknown>} */ (latest.key));
          }
        });
        recordAsPage.insertAdjacentElement('afterend', fixBtn);
      }
      const hasSiblings = Array.isArray(activeConn?.siblings) && activeConn.siblings.length > 0;
      if (hasSiblings && !shellById('wb-compare-record-btn')) {
        const cmpBtn = document.createElement('button');
        cmpBtn.id = 'wb-compare-record-btn';
        cmpBtn.type = 'button';
        cmpBtn.tabIndex = -1;
        cmpBtn.className = 'ghost';
        cmpBtn.title = say('compareRecordEnvsTitle');
        cmpBtn.textContent = say('compareRecordEnvsBtn');
        cmpBtn.addEventListener('click', () => {
          const latest = currentEntry();
          if (latest?.kind === 'row' && latest.table && latest.key) {
            openRecordCompareModal(latest.table, /** @type {Record<string, unknown>} */ (latest.key));
          }
        });
        (shellById('wb-extract-fixture-btn') ?? recordAsPage).insertAdjacentElement('afterend', cmpBtn);
      } else if (!hasSiblings) {
        shellById('wb-compare-record-btn')?.remove();
      }
    } else {
      shellById('wb-extract-fixture-btn')?.remove();
      shellById('wb-compare-record-btn')?.remove();
    }

    /* 3. Per-column `masked` badges on redacted connections */
    if (activeConn?.redactsRows && state.activeConnection) {
      ensureRedactedMap(state.activeConnection);
      const map = redactedByConn.get(state.activeConnection);
      const entry = currentEntry();
      const activeTableId = entry && typeof entry.table === 'string' ? entry.table : null;
      const maskedSet = new Set(activeTableId && map ? (map[activeTableId] ?? []) : []);
      if (maskedSet.size > 0) {
        for (const th of shellQueryAll('th')) {
          const col =
            th.querySelector('.th-label')?.textContent?.trim() ??
            th.querySelector('.th-filter[data-column]')?.getAttribute('data-column') ??
            '';
          if (!col || !maskedSet.has(col) || th.querySelector('.wb-masked-col-pill')) continue;
          const badge = document.createElement('span');
          badge.className = 'wb-masked-col-pill';
          badge.title = say('maskedColTitle');
          badge.textContent = say('maskedColBadge');
          const sortBtn = th.querySelector('.th-sort');
          if (sortBtn) sortBtn.append(badge);
          else th.append(badge);
        }
        for (const labelEl of shellQueryAll('.field-name, .record-field-name, dt')) {
          if (labelEl.querySelector('.wb-masked-col-pill')) continue;
          const firstToken = (labelEl.childNodes[0]?.textContent ?? labelEl.textContent ?? '').trim().split(/\s+/)[0];
          if (!firstToken || !maskedSet.has(firstToken)) continue;
          const badge = document.createElement('span');
          badge.className = 'wb-masked-col-pill';
          badge.title = say('maskedColTitle');
          badge.textContent = say('maskedColBadge');
          labelEl.append(badge);
        }
      }
    } else {
      for (const stale of shellQueryAll('.wb-masked-col-pill')) stale.remove();
    }

    /* 4. Schema landing polish: de-duplicate ER title, fix runner-up chip captions, add diagnostic chips */
    const landingStartsHead = shellQuery('.landing-starts-head');
    if (landingStartsHead && !landingStartsHead.querySelector('[data-wb-landing-tools]')) {
      const wrap = document.createElement('span');
      wrap.dataset.wbLandingTools = '1';
      wrap.style.display = 'inline-flex';
      wrap.style.gap = 'var(--space-2)';
      wrap.style.flexWrap = 'wrap';

      const shapeBtn = document.createElement('button');
      shapeBtn.type = 'button';
      shapeBtn.tabIndex = -1;
      shapeBtn.className = 'ghost wb-landing-tool';
      shapeBtn.textContent = say('checkShapeChip');
      shapeBtn.addEventListener('click', () => openShapeCheck('lint'));
      wrap.append(shapeBtn);

      if ((state.schema?.tables?.length ?? 0) >= 2) {
        const pathBtn = document.createElement('button');
        pathBtn.type = 'button';
        pathBtn.tabIndex = -1;
        pathBtn.className = 'ghost wb-landing-tool';
        pathBtn.textContent = say('joinPathsChip');
        pathBtn.addEventListener('click', () => openShapeCheck('paths'));
        wrap.append(pathBtn);
      }
      landingStartsHead.append(wrap);
    }

    const landingDiagramTitle = shellQuery('.landing-top ~ .diagram .diagram-head .diagram-title');
    if (landingDiagramTitle && landingDiagramTitle.dataset.wbPolished !== '1') {
      landingDiagramTitle.dataset.wbPolished = '1';
      landingDiagramTitle.textContent = say('schemaDiagramHeading');
    }

    const startChips = shellQueryAll('.landing-chips .start-chip');
    if (startChips.length > 1 && state.schema) {
      const schemaTables = /** @type {Array<{ id: string; name: string; columns?: unknown[] }>} */ (state.schema.tables ?? []);
      const fks = /** @type {Array<{ from: { table: string }; to: { table: string } }>} */ (state.schema.foreignKeys ?? []);
      let seenLargest = false;
      for (const chip of startChips) {
        const nameEl = chip.querySelector('.landing-chip-name');
        const subSpans = chip.querySelectorAll('.landing-chip-table > span');
        const whySpan = subSpans.length > 1 ? subSpans[subSpans.length - 1] : subSpans[0];
        if (!nameEl || !whySpan) continue;
        if (whySpan.textContent?.trim() !== 'the largest table here') continue;
        if (!seenLargest) {
          seenLargest = true;
          continue;
        }
        const tblName = nameEl.textContent?.trim() ?? '';
        const tbl = schemaTables.find((t) => t.name === tblName || t.id === tblName);
        if (!tbl) continue;
        const incoming = fks.filter((fk) => fk.to.table === tbl.id && fk.from.table !== tbl.id).length;
        const outgoing = fks.filter((fk) => fk.from.table === tbl.id).length;
        if (incoming > 0) {
          whySpan.textContent = say('referencedByCount', { count: incoming });
        } else if (outgoing > 0) {
          whySpan.textContent = say('foreignKeysCount', { count: outgoing });
        } else {
          whySpan.textContent = say('columnsCount', { count: tbl.columns?.length ?? 0 });
        }
      }
    }
  };

  /* ---------- Live external MCP agent topbar pill + background Follow-agent co-browsing ---------- */

  let seenMcpSeq = -1;
  let totalExternalMcpCalls = 0;
  let lastExternalTool = '';
  let mcpSupported = true;

  const syncAgentPill = () => {
    const actionsBar = shellQuery('.topbar-actions');
    const sqlToggle = shellById('sql-toggle');
    if (!actionsBar || !sqlToggle || shell().inApp() || totalExternalMcpCalls === 0) {
      shellById('wb-agent-pill')?.remove();
      return;
    }
    let pill = /** @type {HTMLButtonElement | null} */ (shellById('wb-agent-pill'));
    if (!pill) {
      pill = document.createElement('button');
      pill.id = 'wb-agent-pill';
      pill.type = 'button';
      pill.tabIndex = -1;
      pill.className = 'wb-agent-pill';
      pill.title = say('agentLiveTitle');
      pill.addEventListener('click', () => openAgentConsole?.());
      sqlToggle.insertAdjacentElement('beforebegin', pill);
    }
    const following = Boolean(loadJson(FOLLOW_AGENT_KEY, false));
    pill.replaceChildren();
    const dot = document.createElement('span');
    dot.className = 'wb-agent-pill-dot';
    dot.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent =
      following && lastExternalTool
        ? say('agentFollowingPill', { tool: lastExternalTool })
        : say('agentLivePill', { count: totalExternalMcpCalls });
    pill.append(dot, label);
  };

  const pollExternalMcp = () => {
    if (!mcpSupported || document.hidden || shell().inApp() || !canUseDatabaseTools()) return;
    const since = seenMcpSeq > 0 ? seenMcpSeq : 0;
    void api(`/api/agent/activity?since=${since}`)
      .then((data) => {
        if (data?.mcpEndpoint === null) {
          mcpSupported = false;
          return;
        }
        const calls = Array.isArray(data?.calls) ? data.calls.filter((c) => c && (c.via === 'mcp' || c.via === 'mcp-http')) : [];
        const nextSeq = Number(data?.seq ?? 0);
        if (seenMcpSeq < 0) {
          seenMcpSeq = nextSeq;
          totalExternalMcpCalls = calls.length;
          if (calls[0]?.tool) lastExternalTool = String(calls[0].tool);
          syncAgentPill();
          return;
        }
        if (calls.length > 0) {
          totalExternalMcpCalls += calls.length;
          const newest = calls[0];
          if (newest?.tool) lastExternalTool = String(newest.tool);
          const following = Boolean(loadJson(FOLLOW_AGENT_KEY, false));
          const consoleOpen = Boolean(shellQuery('[role="dialog"][aria-label="Agent console"]'));
          if (following && !consoleOpen && newest && !newest.isError) {
            const link =
              (Array.isArray(newest.links) && typeof newest.links[0] === 'string' ? newest.links[0] : undefined) ??
              (typeof newest.answer?.structuredContent?.link === 'string' ? newest.answer.structuredContent.link : undefined);
            if (link) navFollow(link);
          }
        }
        if (nextSeq > seenMcpSeq) seenMcpSeq = nextSeq;
        syncAgentPill();
      })
      .catch(() => {});
  };

  window.setInterval(pollExternalMcp, 3000);

  let rafPending = false;
  const scheduleSync = () => {
    if (rafPending) return;
    rafPending = true;
    window.requestAnimationFrame(() => {
      rafPending = false;
      syncSidebarMeta();
      syncContentPolish();
      enhanceColumnMenus();
    });
  };

  const content = shellById('content');
  if (content) {
    new MutationObserver(scheduleSync).observe(content, { childList: true, subtree: true });
    const tryInspectCell = (/** @type {MouseEvent} */ ev) => {
      if (shell().inApp()) return;
      const target = /** @type {HTMLElement | null} */ (ev.target instanceof HTMLElement ? ev.target : null);
      const td = /** @type {HTMLTableCellElement | null} */ (target?.closest('.result-table tbody td, .grid-host tbody td') ?? null);
      if (!td) return;
      const tableEl = /** @type {HTMLTableElement | null} */ (td.closest('table'));
      if (!tableEl) return;
      const th = tableEl.querySelectorAll('thead th')[td.cellIndex];
      const colName = (
        th?.getAttribute('data-column') ??
        th?.querySelector('.th-filter[data-column]')?.getAttribute('data-column') ??
        th?.querySelector('.th-label')?.textContent ??
        th?.textContent ??
        ''
      ).trim();
      if (!colName) return;
      ev.preventDefault();
      ev.stopPropagation();
      const entry = currentEntry();
      openCellInspector(td, colName, typeof entry?.table === 'string' ? entry.table : null);
    };
    content.addEventListener('contextmenu', tryInspectCell);
    content.addEventListener('click', (ev) => {
      if (ev.shiftKey) tryInspectCell(ev);
    });
  }
  const explainPaneEl = shellById('explain-pane');
  if (explainPaneEl) {
    new MutationObserver(scheduleSync).observe(explainPaneEl, { attributes: true, childList: true, subtree: true });
  }
  const portal = portalRoot() ?? shellBody();
  if (portal) {
    new MutationObserver(() => enhanceColumnMenus()).observe(portal, { childList: true, subtree: true });
  }
  const tableList = shellById('table-list');
  if (tableList) {
    new MutationObserver(scheduleSync).observe(tableList, { childList: true });
  }
  let prevConnId = state.activeConnection ?? null;
  whenConnectionChanges(() => {
    sidebarKind = 'all';
    const sidebar = shellQuery('.sidebar');
    if (sidebar) delete sidebar.dataset.sidebarKind;
    closeProfilePopover();
    if (state.activeConnection) {
      syncSiblingBrowserStores(prevConnId, state.activeConnection);
      prevConnId = state.activeConnection;
    }
    scheduleSync();
  });
  onNavigate(() => {
    closeProfilePopover();
    scheduleSync();
  });
  addHostListener(window, 'resize', scheduleSync);
  if (state.activeConnection) syncSiblingBrowserStores(null, state.activeConnection);
  scheduleSync();
  window.setTimeout(pollExternalMcp, 800);
}
