/**
 * Runtime workspace refinements for the Refined Instrument Pro Workbench:
 *   1. Segmented sidebar scope (`All · Tables · Views`) + `Focused` connection indicator
 *   2. Collapsible single-line quick-filter toggle (`Filters`) in the table room tab strip
 *   3. Schema landing polish: de-duplicated ER heading, accurate runner-up starter chip
 *      captions, and 1-click `Check shape & perf` / `Join paths` launchers.
 *
 * Loaded dynamically from `workbench.js` so zero bytes land in the cold first-paint JS/CSS budget,
 * and every injected quick button carries `tabIndex = -1` so keyboard roving and Tab-stop order stay untouched.
 */
import { state, whenConnectionChanges } from '@mistriwork/kit/client/core.js';
import { shell } from '@mistriwork/kit/client/shellMode.js';
import { addHostListener, onNavigate, shellBody, shellById, shellQuery, shellQueryAll } from '@mistriwork/kit/client/shellHost.js';
import { say } from './copy/workbench/workbenchEnhancements.js';
import './workbenchEnhancements.css';

const FILTER_COLLAPSED_KEY = 'tablewalk.filters.collapsed';

/**
 * @param {{ openShapeCheck: (tab?: import('./components/ShapeCheck.js').ShapeTab) => void }} actions
 */
export function initWorkbenchEnhancements({ openShapeCheck }) {
  let filtersCollapsed = false;
  try {
    filtersCollapsed = window.localStorage.getItem(FILTER_COLLAPSED_KEY) === '1';
  } catch {
    /* Storage unavailable. */
  }
  shellBody().classList.toggle('wb-filters-collapsed', filtersCollapsed);

  /** @type {'all' | 'tables' | 'views'} */
  let sidebarKind = 'all';

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
          try {
            window.localStorage.setItem(FILTER_COLLAPSED_KEY, filtersCollapsed ? '1' : '0');
          } catch {
            /* Ignore storage errors. */
          }
          syncContentPolish();
        });
        /* Insert right before the right-aligned action (e.g. Copy app entry) or at end of .tabs. */
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

    /* 2. Schema landing polish: de-duplicate ER title, fix runner-up chip captions, add diagnostic chips */
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

    /* De-duplicate repeated database label above the overview ER diagram */
    const landingDiagramTitle = shellQuery('.landing-top ~ .diagram .diagram-head .diagram-title');
    if (landingDiagramTitle && landingDiagramTitle.dataset.wbPolished !== '1') {
      landingDiagramTitle.dataset.wbPolished = '1';
      landingDiagramTitle.textContent = say('schemaDiagramHeading');
    }

    /* Fix runner-up starter chips where Summary.js repeated "the largest table here" */
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

  let rafPending = false;
  const scheduleSync = () => {
    if (rafPending) return;
    rafPending = true;
    window.requestAnimationFrame(() => {
      rafPending = false;
      syncSidebarMeta();
      syncContentPolish();
    });
  };

  const content = shellById('content');
  if (content) {
    new MutationObserver(scheduleSync).observe(content, { childList: true, subtree: true });
  }
  const tableList = shellById('table-list');
  if (tableList) {
    new MutationObserver(scheduleSync).observe(tableList, { childList: true });
  }
  whenConnectionChanges(() => {
    sidebarKind = 'all';
    const sidebar = shellQuery('.sidebar');
    if (sidebar) delete sidebar.dataset.sidebarKind;
    scheduleSync();
  });
  onNavigate(scheduleSync);
  addHostListener(window, 'resize', scheduleSync);
  scheduleSync();
}
