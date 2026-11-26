/**
 * Syntax-highlighted SQL editor layered directly over the native textarea.
 *
 * Keeping the native `<textarea>` as the real input preserves browser undo/redo,
 * screen-reader combobox semantics (`attachComplete`), IME input, and exact
 * selection ranges, while the synchronized `<pre>` backdrop renders real-time
 * dialect-aware SQL syntax highlighting and an active-statement indicator for
 * multi-statement scripts.
 */
import { useEffect, useMemo, useRef, type KeyboardEvent, type RefObject } from 'react';
import { attachComplete } from '../complete.js';
import { sqlSuggestions, tokenAt } from '../sqlcomplete.js';
import { tokenizeSql, type SqlDialect } from '../../shared/sqlHighlight.js';

export interface ActiveRange {
  start: number;
  end: number;
}

interface SqlCodeEditorProps {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  defaultValue: string;
  dialect: SqlDialect;
  placeholder: string;
  ariaLabel: string;
  activeRange?: ActiveRange | null;
  onValueChange: (next: string) => void;
  onCaretChange: (start: number, end: number) => void;
  onRunShortcut: () => void;
  onSaveShortcut?: () => void;
}

/* A textarea that grows with its content, to a point. */
export function autoGrowSqlInput(input: HTMLTextAreaElement, backdrop?: HTMLPreElement | null) {
  input.style.height = 'auto';
  const h = `${Math.min(Math.max(input.scrollHeight, 84), 340)}px`;
  input.style.height = h;
  if (backdrop) backdrop.style.height = h;
}

interface HighlightSegment {
  kind: string;
  text: string;
  active: boolean;
}

function buildSegments(sql: string, dialect: SqlDialect, activeRange?: ActiveRange | null): HighlightSegment[] {
  const tokens = tokenizeSql(sql, dialect);
  if (!activeRange) {
    return tokens.map((t) => ({ kind: t.kind, text: t.text, active: false }));
  }
  const { start: aStart, end: aEnd } = activeRange;
  const out: HighlightSegment[] = [];
  for (const tok of tokens) {
    if (tok.end <= aStart || tok.start >= aEnd) {
      out.push({ kind: tok.kind, text: tok.text, active: false });
      continue;
    }
    if (tok.start < aStart) {
      out.push({ kind: tok.kind, text: tok.text.slice(0, aStart - tok.start), active: false });
    }
    const midStart = Math.max(tok.start, aStart) - tok.start;
    const midEnd = Math.min(tok.end, aEnd) - tok.start;
    out.push({ kind: tok.kind, text: tok.text.slice(midStart, midEnd), active: true });
    if (tok.end > aEnd) {
      out.push({ kind: tok.kind, text: tok.text.slice(aEnd - tok.start), active: false });
    }
  }
  return out;
}

export function SqlCodeEditor({
  inputRef,
  value,
  defaultValue,
  dialect,
  placeholder,
  ariaLabel,
  activeRange,
  onValueChange,
  onCaretChange,
  onRunShortcut,
  onSaveShortcut,
}: SqlCodeEditorProps) {
  const backdropRef = useRef<HTMLPreElement>(null);
  const onValueChangeRef = useRef(onValueChange);
  const onCaretChangeRef = useRef(onCaretChange);
  onValueChangeRef.current = onValueChange;
  onCaretChangeRef.current = onCaretChange;

  useEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    const detach = attachComplete(node, sqlSuggestions, {
      anchor: 'caret',
      split: tokenAt,
      onAccept: (nextVal: string) => {
        onValueChangeRef.current(nextVal);
        autoGrowSqlInput(node, backdropRef.current);
        onCaretChangeRef.current(node.selectionStart ?? nextVal.length, node.selectionEnd ?? nextVal.length);
      },
    }) as (() => void) | undefined;
    autoGrowSqlInput(node, backdropRef.current);
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
    onCaretChangeRef.current(node.value.length, node.value.length);
    return () => detach?.();
  }, [inputRef]);

  useEffect(() => {
    const node = inputRef.current;
    if (node) autoGrowSqlInput(node, backdropRef.current);
  }, [value, inputRef]);

  const segments = useMemo(() => buildSegments(value, dialect, activeRange), [value, dialect, activeRange]);

  const syncScroll = (target: HTMLTextAreaElement) => {
    const pre = backdropRef.current;
    if (!pre) return;
    pre.scrollTop = target.scrollTop;
    pre.scrollLeft = target.scrollLeft;
  };

  const reportCaret = (target: HTMLTextAreaElement) => {
    onCaretChange(target.selectionStart ?? 0, target.selectionEnd ?? 0);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onRunShortcut();
      return;
    }
    if ((e.key === 's' || e.key === 'S') && (e.metaKey || e.ctrlKey) && onSaveShortcut) {
      e.preventDefault();
      onSaveShortcut();
    }
  };

  return (
    <div className="sql-editor-wrap">
      <pre ref={backdropRef} className="sql-highlight-layer" aria-hidden="true">
        {segments.map((seg, i) => {
          const cls =
            seg.kind === 'plain'
              ? seg.active
                ? 'sql-active-stmt'
                : undefined
              : seg.active
                ? `sql-tok-${seg.kind} sql-active-stmt`
                : `sql-tok-${seg.kind}`;
          return cls ? (
            <span key={i} className={cls}>
              {seg.text}
            </span>
          ) : (
            <span key={i}>{seg.text}</span>
          );
        })}
        {value.endsWith('\n') ? ' ' : ''}
      </pre>
      <textarea
        ref={inputRef}
        className="sql-input sql-input-highlighted"
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        aria-label={ariaLabel}
        placeholder={placeholder}
        defaultValue={defaultValue}
        onInput={(e) => {
          onValueChange(e.currentTarget.value);
          autoGrowSqlInput(e.currentTarget, backdropRef.current);
          reportCaret(e.currentTarget);
          syncScroll(e.currentTarget);
        }}
        onScroll={(e) => syncScroll(e.currentTarget)}
        onClick={(e) => reportCaret(e.currentTarget)}
        onKeyUp={(e) => reportCaret(e.currentTarget)}
        onSelect={(e) => reportCaret(e.currentTarget)}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
}
