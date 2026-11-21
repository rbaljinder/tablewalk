/** What workbench says, in the Workbench room (the kit package's client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  connectionsMore: 'Connections…',
  addEditSaveToAFile: 'add, edit, save to a file',
  editingEnabled: 'Editing enabled',
  changesRequireReviewAndApply: 'changes require review and apply',
  everyTableInThisDatabase: 'every table in this database',
  undoTheLastEdit: 'Undo the last edit',
  nothingToUndoHint: 'nothing to undo',
  writeAQuery: 'Write a query…',
  theQueryBarWithRoom: 'the query bar, with room (⌘/)',
  findAValue: 'Find a value…',
  whichTableMentions: 'which table mentions this?',
  checkTheShape: 'Check the shape…',
  whatThisSchemaWill: 'what this schema will cost',
  findPathBetweenTables: 'Find path between tables…',
  shortestForeignKeyWalks: 'shortest foreign-key walks, index coverage and query hints',
  driveTheMcpTools: 'drive the MCP tools by hand, see what an agent sees',
  copyBriefForAgent: 'Copy brief for agent',
  copyContextForAgent: 'copy this view, key and MCP call as Markdown',
  fromTablewalkJson: 'from tablewalk.json',
  savedSql: 'saved SQL',
  switchToEnv: 'Switch to {database} · {env}',
  keepViewOnName: '{name} — keep current view',
});
