/** What Ask says, in the Workbench room (the kit package's client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  writeAQuery: 'Write a query',
  query: 'Query',
  by: 'by',
  groups: ' groups — ',
  enterToRunEsc: 'Enter to run · Esc to cancel',
  targetEnvLabel: 'Target: {name}',
  maskedBadge: 'masked',
  previewBreakdown: 'Breakdown over {table}',
  previewJoinedView: 'Joined view from {table}',
});
