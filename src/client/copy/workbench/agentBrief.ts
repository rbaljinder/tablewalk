/** What agentBrief says, in the Workbench room. */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  copiedBrief: 'Copied brief for agent',
  couldNotCopy: 'Could not copy to clipboard',
  headingRecord: '## tablewalk — `{table}` record',
  headingBreakdown: '## tablewalk — `{table}` breakdown',
  headingTable: '## tablewalk — `{table}` query',
  headingSchema: '## tablewalk — `{connection}` schema',
  lineConnection: '- Connection: `{connection}` ({dialect})',
  lineLink: '- Link: `{link}`',
  lineKey: '- Key: `{key}`',
  lineLabel: '- Label: {label}',
  lineQuery: '- Query: `{query}`',
  linePointsAt: '- Points at: {targets}',
  linePointedAtBy: '- Pointed at by: {sources}',
  lineCounts: '- Shape: {tables} tables, {fks} foreign keys',
  lineEnvironment: '- Environment: `{database}` · `{env}` ({posture})',
  lineSiblings: '- Sibling environments: {siblings}',
  postureWritable: 'writable',
  postureReadOnly: 'read-only',
  postureShapeOnly: 'shape-only',
  lineMcpCall: '- MCP `{tool}`: `{args}`',
});
