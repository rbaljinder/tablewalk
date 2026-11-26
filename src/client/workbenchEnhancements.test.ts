import { beforeEach, expect, test, vi } from 'vitest';

const store = new Map<string, unknown>();

const mockState = {
  activeConnection: 'billing-local',
  schema: null as unknown,
  connections: [
    {
      id: 'billing-local',
      name: 'billing-local',
      database: 'billing',
      env: 'local',
      explicit: true,
      siblings: [{ id: 'billing-staging', name: 'billing-staging', env: 'staging', tier: 'staging', writable: false }],
    },
    {
      id: 'billing-staging',
      name: 'billing-staging',
      database: 'billing',
      env: 'staging',
      explicit: true,
      siblings: [{ id: 'billing-local', name: 'billing-local', env: 'local', tier: 'local', writable: true }],
    },
    {
      id: 'analytics',
      name: 'analytics',
    },
  ],
};

vi.mock('@mistriwork/kit/client/core.js', () => ({
  state: mockState,
  api: async () => ({ queries: [] }),
  loadJson: (key: string, fallback: unknown) => {
    if (!store.has(key)) return structuredClone(fallback);
    return structuredClone(store.get(key));
  },
  saveJson: (key: string, val: unknown) => {
    store.set(key, structuredClone(val));
    return true;
  },
  toast: () => {},
  quote: (v: unknown) => `'${String(v)}'`,
  currentEntry: () => null,
  viewportBox: () => ({ left: 0, top: 0, bottom: 20, right: 100, width: 100, height: 20 }),
  viewportSize: () => ({ width: 1280, height: 800 }),
  whenConnectionChanges: () => {},
}));

vi.mock('@mistriwork/kit/client/connectionScope.js', () => ({
  canUseDatabaseTools: () => true,
}));

vi.mock('@mistriwork/kit/client/connectionTransition.js', () => ({
  connectionGeneration: () => 1,
}));

vi.mock('@mistriwork/kit/client/sessionIdentity.js', () => ({
  sessionIdentity: () => 'local',
  subscribeSessionIdentity: () => () => {},
}));

vi.mock('@mistriwork/kit/client/menu.js', () => ({
  menuMode: () => 'workbench',
}));

vi.mock('@mistriwork/kit/client/palette.js', () => ({
  addPaletteSource: () => {},
}));

const {
  appendShowProjection,
  buildQuickCellFilter,
  extractVisibleGridData,
  inspectCellValue,
  recordRecentQueryInStore,
  syncSiblingBrowserStores,
} = await import('./workbenchEnhancements.js');
const { saveStatement, savedStatements } = await import('./sqlsaved.js');

beforeEach(() => {
  store.clear();
  mockState.activeConnection = 'billing-local';
});

test('recordRecentQueryInStore skips bare table names, deduplicates case-insensitively, and caps at 15', () => {
  const ring: Record<string, string[]> = {};
  expect(recordRecentQueryInStore(ring, '@db:billing', '')).toBe(false);
  expect(recordRecentQueryInStore(ring, '@db:billing', 'invoice')).toBe(false);
  expect(ring['@db:billing']).toBeUndefined();

  expect(recordRecentQueryInStore(ring, '@db:billing', 'invoice   status = issued')).toBe(true);
  expect(recordRecentQueryInStore(ring, '@db:billing', 'invoice count by status')).toBe(true);
  expect(recordRecentQueryInStore(ring, '@db:billing', 'INVOICE status = issued')).toBe(true);
  expect(ring['@db:billing']).toEqual(['INVOICE status = issued', 'invoice count by status']);

  for (let i = 1; i <= 20; i++) {
    recordRecentQueryInStore(ring, '@db:billing', `invoice total > ${i}`);
  }
  expect(ring['@db:billing']).toHaveLength(15);
  expect(ring['@db:billing']?.[0]).toBe('invoice total > 20');
});

test('appendShowProjection appends FK dot-path projections without duplicating columns', () => {
  expect(
    appendShowProjection(
      'invoice status = issued sort total desc',
      'invoice',
      ['id', 'customer_id', 'total', 'status'],
      'customer_id.name',
    ),
  ).toBe('invoice status = issued show id, customer_id, total, status, customer_id.name sort total desc');

  expect(
    appendShowProjection('invoice show id, total sort total desc', 'invoice', ['id', 'customer_id', 'total'], 'customer_id.name'),
  ).toBe('invoice show id, total, customer_id.name sort total desc');

  expect(appendShowProjection('invoice show id, customer_id.name', 'invoice', ['id'], 'customer_id.name')).toBe(
    'invoice show id, customer_id.name',
  );
});

test('saved SQL statements and browser stores share across sibling environments of a logical database, not unrelated connections', () => {
  mockState.activeConnection = 'billing-local';
  expect(saveStatement('Open high-value', 'SELECT * FROM invoice WHERE total > 500')).toBe(true);

  mockState.activeConnection = 'billing-staging';
  expect(savedStatements().map((s) => s.name)).toEqual(['Open high-value']);

  mockState.activeConnection = 'analytics';
  expect(savedStatements()).toEqual([]);

  // Seed table filter, composer view, and pinned columns on billing-local, then switch to billing-staging.
  store.set('mistri.views.v1', {
    'billing-local': { invoice: [{ name: 'Issued', query: "invoice status = 'issued'" }] },
  });
  store.set('mistri.composer.v1', {
    'billing-local': { views: [{ id: 'v1', name: 'Customer invoices' }], pinned: ['v1'] },
  });
  store.set('mistri.pins.v1', {
    'billing-local': { invoice: ['id', 'total'] },
  });

  syncSiblingBrowserStores('billing-local', 'billing-staging');

  const filters = store.get('mistri.views.v1') as Record<string, Record<string, Array<{ name: string }>>>;
  expect(filters['billing-staging']?.invoice?.map((x) => x.name)).toEqual(['Issued']);
  expect(filters.analytics).toBeUndefined();

  const composer = store.get('mistri.composer.v1') as Record<string, { views: Array<{ name: string }>; pinned: string[] }>;
  expect(composer['billing-staging']?.views.map((v) => v.name)).toEqual(['Customer invoices']);
  expect(composer['billing-staging']?.pinned).toEqual(['v1']);

  const pins = store.get('mistri.pins.v1') as Record<string, Record<string, string[]>>;
  expect(pins['billing-staging']?.invoice).toEqual(['id', 'total']);
});

test('inspectCellValue recognizes JSON, ISO timestamps, UUIDs, multiline text, and nulls', () => {
  const jsonInfo = inspectCellValue('{"tier":"pro","seats":5}');
  expect(jsonInfo.kind).toBe('json');
  expect(jsonInfo.formatted).toContain('\n  "tier": "pro"');
  expect(jsonInfo.meta).toEqual(['2 keys']);

  const tsInfo = inspectCellValue('2026-05-01T14:30:00Z');
  expect(tsInfo.kind).toBe('timestamp');
  expect(tsInfo.utc).toBe('2026-05-01T14:30:00.000Z');

  const uuidInfo = inspectCellValue('550e8400-e29b-41d4-a716-446655440000');
  expect(uuidInfo.kind).toBe('uuid');

  const nullInfo = inspectCellValue('', true);
  expect(nullInfo.kind).toBe('null');
  expect(nullInfo.formatted).toBe('NULL');

  const textInfo = inspectCellValue('line 1\nline 2');
  expect(textInfo.kind).toBe('text');
  expect(textInfo.meta).toEqual(['13 chars', '2 lines']);
});

test('buildQuickCellFilter composes =, !=, is empty, and is not empty filters cleanly', () => {
  expect(buildQuickCellFilter('invoice sort total desc', 'invoice', 'status', 'paid', '=')).toBe("invoice status = 'paid' sort total desc");
  expect(buildQuickCellFilter("invoice status = 'paid'", 'invoice', 'currency', 'EUR', '!=')).toBe(
    "invoice status = 'paid' and currency != 'EUR'",
  );
  expect(buildQuickCellFilter('invoice', 'invoice', 'paid_at', null, 'empty')).toBe('invoice paid_at is empty');
  expect(buildQuickCellFilter('invoice', 'invoice', 'paid_at', null, 'not-empty')).toBe('invoice paid_at is not empty');
});

test('extractVisibleGridData extracts headers, numeric values, and nulls from a rendered grid table', () => {
  const table = document.createElement('table');
  table.innerHTML = `
    <thead>
      <tr>
        <th data-column="id"><span class="th-label">id</span></th>
        <th data-column="name"><span class="th-label">name</span></th>
        <th data-column="total"><span class="th-label">total</span></th>
      </tr>
    </thead>
    <tbody>
      <tr><td>1</td><td>Ada</td><td>1,250.50</td></tr>
      <tr><td>2</td><td class="null">null</td><td>500</td></tr>
    </tbody>
  `;
  const data = extractVisibleGridData(table);
  expect(data.columns).toEqual(['id', 'name', 'total']);
  expect(data.rows).toEqual([
    [1, 'Ada', 1250.5],
    [2, null, 500],
  ]);
});
