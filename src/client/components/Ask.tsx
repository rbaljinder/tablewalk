/**
 * The query bar, in the middle of the screen.
 *
 * The bar in the header is right for refining what you are already looking
 * at; it is the wrong surface for *writing* a query — a single line ninety
 * characters wide sharing the header with everything else. This is the same
 * input given room: centred, wrapped, nothing else on screen, on ⌘/ beside
 * ⌘K. **⌘K goes to things, ⌘/ asks things.**
 *
 * It does not run the query itself. Which endpoint answers a line — a `by`
 * clause means a breakdown, everything else a view — is decided in one
 * place, and the caller hands that in as `onRun`. A textarea so a long line
 * wraps rather than scrolls; the language is single-line, so Enter runs and
 * a pasted newline is flattened rather than sent to a parser that has no
 * idea what to do with it.
 */
import { useEffect, useRef, useState } from 'react';
import { state } from '@mistriwork/kit/client/core.js';
import { explain, parseQuery } from '@mistriwork/engine/shared/query.js';
import { textToView } from '@mistriwork/engine/shared/viewtext.js';
import { looksLikeBreakdown } from '@mistriwork/engine/shared/breakdowntext.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { Modal, type ModalHandle } from '@mistriwork/ui/Modal.js';
import { attachComplete, suggestionsFor } from '../complete.js';
import { enrichConnectionsWithEnvironments, type EnvironmentTier } from '../../shared/environments.js';
import { say } from '../copy/workbench/components/Ask.js';
import './Ask.css';

interface AskConn {
  id: string;
  name?: string;
  env?: string;
  tier?: EnvironmentTier;
  writable?: boolean;
  rows?: boolean;
  redactsRows?: boolean;
}

function summarizeDraft(schema: DatabaseSchema | undefined, raw: string): { text: string; issue?: boolean } | null {
  const clean = raw.replace(/\s+/g, ' ').trim();
  if (!clean || !schema?.tables?.length) return null;
  if (looksLikeBreakdown(clean)) {
    const first = clean.split(/\s+/)[0];
    const tbl = schema.tables.find((t) => t.id === first || t.name === first || t.name.toLowerCase() === first.toLowerCase());
    return tbl ? { text: say('previewBreakdown', { table: tbl.name }) } : null;
  }
  const parsed = parseQuery(clean, { schema });
  if (parsed.query && !parsed.errors.length) {
    return { text: explain(parsed.query) };
  }
  const asView = textToView(schema, clean, { id: 'ask', name: '' });
  if (asView.view && !asView.errors.length) {
    return { text: say('previewJoinedView', { table: asView.view.base }) };
  }
  const msg = parsed.errors[0]?.message ?? asView.errors[0]?.message;
  return msg ? { text: msg, issue: true } : null;
}

export function AskDialog({ initial = '', onRun, onClose }: { initial?: string; onRun?: (text: string) => void; onClose: () => void }) {
  const dialog = useRef<ModalHandle>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(initial);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    return attachComplete(el, suggestionsFor, { anchor: 'caret', preserveRole: true });
  }, []);

  const appState = state as {
    schema?: DatabaseSchema;
    activeConnection?: string;
    connections?: AskConn[];
  };
  const enriched = enrichConnectionsWithEnvironments((appState.connections ?? []).map((c) => ({ ...c, name: c.name ?? c.id })));
  const activeConn = enriched.find((c) => c.id === appState.activeConnection);
  const preview = summarizeDraft(appState.schema, draft);

  const run = () => {
    const text = (input.current?.value ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    dialog.current?.close();
    onRun?.(text);
  };
  const sync = () => setDraft(input.current?.value ?? '');

  return (
    <Modal className="ask" ref={dialog} onClose={onClose} initialFocus={input} ariaLabel={say('writeAQuery')} plain>
      {activeConn && (activeConn.env || activeConn.redactsRows) ? (
        <div className="ask-target">
          <span>{say('targetEnvLabel', { name: activeConn.database ?? activeConn.name })}</span>
          {activeConn.env ? <span className={`env-pill compact tone-${activeConn.tier}`}>{activeConn.env}</span> : null}
          {activeConn.redactsRows ? <span className="conn-badge">{say('maskedBadge')}</span> : null}
        </div>
      ) : null}
      {/* Arrives selected, so typing replaces it and an arrow key keeps it. */}
      <textarea
        ref={input}
        className="ask-input"
        rows={3}
        spellCheck={false}
        autoComplete="off"
        aria-label={say('query')}
        placeholder="customer active = true sort name limit 20"
        defaultValue={initial}
        onFocus={(e) => e.currentTarget.select()}
        onInput={sync}
        onKeyUp={sync}
        onClick={sync}
        onKeyDown={(e) => {
          if (e.defaultPrevented) return;
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            run();
          }
        }}
      />
      {preview ? <div className={`ask-preview${preview.issue ? ' has-issue' : ''}`}>{preview.text}</div> : null}
      <div className="ask-foot">
        {/* What the language can do that the placeholder cannot show: `by` is the newest clause and the least guessable. */}
        <span className="ask-hint">
          <code>{say('by')}</code>
          {say('groups')}
          <code>invoice count by status</code>
        </span>
        <span className="ask-keys">{say('enterToRunEsc')}</span>
      </div>
    </Modal>
  );
}
