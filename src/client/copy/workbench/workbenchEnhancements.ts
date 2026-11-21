/** What workbenchEnhancements says, in the Workbench room (the kit package's client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  scopeAll: 'All',
  scopeTables: 'Tables',
  scopeViews: 'Views',
  focusedScope: { one: 'Focused · {count} table', other: 'Focused · {count} tables' },
  filtersToggle: 'Filters',
  filtersToggleCount: 'Filters · {count}',
  toggleQuickFilters: 'Show or hide quick filters',
  schemaDiagramHeading: 'Entity diagram',
  checkShapeChip: 'Check shape & perf',
  joinPathsChip: 'Join paths',
  referencedByCount: { one: 'referenced by {count} table', other: 'referenced by {count} tables' },
  foreignKeysCount: { one: '{count} foreign key', other: '{count} foreign keys' },
  columnsCount: { one: '{count} column', other: '{count} columns' },
});
