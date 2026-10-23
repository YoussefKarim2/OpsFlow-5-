/**
 * A dropdown you can also type into.
 *
 * Every dropdown in OpsFlow is this component. It keeps the dropdown — the
 * arrow opens the whole list, exactly the options a native <select> had — and
 * adds a text box: typing narrows the list, Enter or a click picks, and the
 * arrow keys move through it.
 *
 * What typing can do depends on what the field stores:
 *   - `allowCustom`: the field is free text with suggestions (a season, a
 *     fabric, an item). Enter still takes the highlighted suggestion, so a
 *     half-typed word never becomes a value by accident; new text is kept from
 *     the "Use …" row (arrow up to it, or click it), or by Tab / leaving the box.
 *   - otherwise the value must be one of the list — an id, a status — so typing
 *     searches; text that matches no option is put back to the current choice
 *     when the box is left, rather than saving something the server would refuse.
 *
 * It is a drop-in for <select>: the same <option> children, `value`, and an
 * `onChange` that receives an event whose `target.value` is the chosen value.
 */

import {
  Children, Fragment, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type ChangeEvent, type KeyboardEvent, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { clsx } from './ui';

interface Opt { value: string; label: string; disabled: boolean }

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

function collect(children: ReactNode, out: Opt[]): Opt[] {
  Children.forEach(children, (c) => {
    if (!isValidElement<{ value?: unknown; children?: ReactNode; disabled?: boolean }>(c)) return;
    if (c.type === 'option') {
      const label = oneLine(textOf(c.props.children));
      out.push({ value: c.props.value === undefined ? label : String(c.props.value), label, disabled: !!c.props.disabled });
    } else if (c.type === 'optgroup' || c.type === Fragment) {
      collect(c.props.children, out);
    }
  });
  return out;
}

const norm = (s: string) => s.trim().toLowerCase();
/** One line: a multi-line value (an address) reads with separators in a one-line box. */
const oneLine = (s: string) => s.replace(/\s*\n+\s*/g, ' · ').trim();

export interface ComboSelectProps {
  value?: string | number | null;
  onChange?: (e: ChangeEvent<HTMLSelectElement>) => void;
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  /** The field stores text: keep what is typed even when it is not in the list. */
  allowCustom?: boolean;
  placeholder?: string;
  id?: string;
  name?: string;
  title?: string;
  autoFocus?: boolean;
  'aria-label'?: string;
}

export function ComboSelect({
  value: rawValue, onChange, children, className, disabled, allowCustom, placeholder, id, name, title, autoFocus,
  'aria-label': ariaLabel,
}: ComboSelectProps) {
  const options = useMemo(() => collect(children, []), [children]);
  const value = rawValue == null ? '' : String(rawValue);
  const current = options.find((o) => o.value === value);
  // A value outside a fixed list (an id that has since gone) is not shown raw.
  const shown = current ? current.label : allowCustom ? oneLine(value) : '';

  const [open, setOpen] = useState(false);
  /** What is being typed; null while the box shows the current choice. */
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; width: number; maxWidth: number; maxHeight: number } | null>(null);
  /** Whether the highlight was last moved by the mouse: Tab then keeps the current choice. */
  const hovered = useRef(false);
  /** When the box itself was last pressed, so a <label> around it cannot reopen the list it just closed. */
  const boxPressedAt = useRef(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  const typing = query !== null && query !== shown;
  const matches = useMemo(() => {
    const usable = options.filter((o) => !o.disabled);
    if (!typing) return usable;
    const q = norm(query!);
    if (!q) return usable;
    // An exact match first, so Enter takes "Navy" over "Navy Melange", the
    // same choice leaving the box would make.
    const isExact = (o: Opt) => norm(o.label) === q || o.value === query!.trim();
    const starts = usable.filter((o) => norm(o.label).startsWith(q)).sort((a, b) => Number(isExact(b)) - Number(isExact(a)));
    const contains = usable.filter((o) => !norm(o.label).startsWith(q) && (norm(o.label).includes(q) || norm(o.value) === q));
    return [...starts, ...contains];
  }, [options, typing, query]);
  const exact = typing ? options.find((o) => !o.disabled && (norm(o.label) === norm(query!) || o.value === query!.trim())) : undefined;
  const offerCustom = !!allowCustom && typing && query!.trim() !== '' && !exact;

  const emit = useCallback((next: string) => {
    if (next === value) return;
    onChange?.({ target: { value: next, name }, currentTarget: { value: next, name } } as unknown as ChangeEvent<HTMLSelectElement>);
  }, [name, onChange, value]);

  const close = () => { setOpen(false); setQuery(null); setActive(-1); hovered.current = false; };
  const pick = (o: Opt) => { emit(o.value); close(); };

  /** Leaving the box: keep a match, keep typed text where the field allows it, otherwise put the choice back. */
  const commit = () => {
    if (typing) {
      const q = query!.trim();
      if (exact) emit(exact.value);
      else if (!q && options.some((o) => o.value === '')) emit('');
      else if (allowCustom) emit(q);
    }
    close();
  };

  // The list is drawn in a layer on top of the page so a table or a dialog
  // that clips its content cannot cut it off; it follows the box on scroll.
  const place = useCallback(() => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r) return;
    // The visible area, which on a phone excludes the on-screen keyboard.
    // Fixed positions count from the page area, which excludes scrollbars.
    const { clientWidth: pageWidth, clientHeight: pageHeight } = document.documentElement;
    const vv = window.visualViewport;
    const viewTop = vv?.offsetTop ?? 0;
    const viewBottom = Math.min(pageHeight, viewTop + (vv?.height ?? pageHeight));
    const below = viewBottom - r.bottom - 8;
    const above = r.top - viewTop - 8;
    const up = below < 200 && above > below;
    const maxHeight = Math.max(80, Math.min(280, up ? above : below));
    // Kept on screen at the right edge; a list opening upwards hangs from the
    // box by its bottom edge, so a short list sits against the box.
    const width = Math.max(r.width, 180);
    const left = Math.max(8, Math.min(r.left, pageWidth - width - 8));
    setPos({
      ...(up ? { bottom: pageHeight - r.top + 2 } : { top: r.bottom + 2 }),
      left, width, maxWidth: Math.min(512, pageWidth - left - 8), maxHeight,
    });
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    return () => {
      window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
    };
  }, [open, place]);

  // Keep the highlighted option in view.
  useEffect(() => {
    if (!open || active < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const openList = () => {
    if (disabled) return;
    setOpen(true);
    const i = matches.findIndex((o) => o.value === value);
    setActive(i);
    hovered.current = false;
  };

  const onType = (text: string) => {
    setQuery(text);
    setOpen(true);
    // Enter takes the best match. Where free text is allowed and nothing
    // matches, Enter keeps what was typed (the "Use …" row).
    setActive(norm(text) ? 0 : -1);
    hovered.current = false;
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const count = matches.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { openList(); return; }
      // With a "Use …" row on top, index -1 is that row.
      const first = offerCustom ? -1 : 0;
      hovered.current = false;
      if (count === 0) { if (offerCustom) setActive(-1); return; }
      setActive((a) => (e.key === 'ArrowDown'
        ? (a + 1 >= count ? first : a + 1)
        : (a <= first ? count - 1 : a - 1)));
    } else if (e.key === 'Enter') {
      if (!open && !typing) return;
      e.preventDefault();
      if (open && active >= 0 && active < count) pick(matches[active]!);
      else commit();
    } else if (e.key === 'Escape') {
      if (open || typing) { e.preventDefault(); e.stopPropagation(); close(); }
    } else if (e.key === 'Tab') {
      // Not an option the pointer merely passed over on the way.
      if (open && active >= 0 && active < count && !hovered.current && (!typing || !allowCustom)) pick(matches[active]!);
      else commit();
    }
  };

  const longest = options.reduce((a, o) => Math.max(a, o.label.length), (placeholder ?? '').length);

  return (
    <div
      ref={boxRef}
      className={clsx(
        'relative inline-flex items-center gap-1 align-middle',
        'focus-within:border-accent-500 focus-within:ring-1 focus-within:ring-accent-500',
        className,
        disabled && 'cursor-not-allowed !bg-ink-50 !text-ink-500',
      )}
      title={title}
      onMouseDown={(e) => {
        // A click anywhere on the box opens the list, like a native dropdown.
        // React passes clicks inside the list up here too (it is the box's
        // child in React even though it is drawn on top of the page), so only
        // clicks on the box itself count.
        if (disabled || e.target === inputRef.current || !boxRef.current?.contains(e.target as Node)) return;
        e.preventDefault();
        boxPressedAt.current = Date.now();
        inputRef.current?.focus();
        // Closing with the arrow keeps typed text the way leaving the box does.
        if (open) commit(); else { openList(); if (query === null) inputRef.current?.select(); }
      }}
    >
      <input
        ref={inputRef}
        id={id}
        name={name}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        disabled={disabled}
        size={Math.max(4, Math.min(40, longest + 1))}
        className="min-w-0 flex-1 border-0 bg-transparent p-0 text-inherit outline-none [font:inherit] [letter-spacing:inherit] [text-transform:inherit] placeholder:text-ink-400 focus:ring-0 disabled:cursor-not-allowed"
        value={query ?? shown}
        placeholder={placeholder}
        onFocus={(e) => { e.currentTarget.select(); }}
        // Opening the list selects the text, so typing replaces the current
        // choice instead of adding to it — also when the box already had focus.
        onClick={(e) => {
          // A <label> around the box passes the press on as a click here.
          if (Date.now() - boxPressedAt.current < 500) return;
          if (!open) { openList(); if (query === null) e.currentTarget.select(); }
        }}
        onChange={(e) => onType(e.target.value)}
        onKeyDown={onKey}
        onBlur={commit}
      />
      <ChevronDown aria-hidden className={clsx('h-3.5 w-3.5 shrink-0 opacity-60 transition-transform', open && 'rotate-180')} />
      {open && pos && createPortal(
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          style={{ position: 'fixed', top: pos.top, bottom: pos.bottom, left: pos.left, minWidth: pos.width, maxWidth: pos.maxWidth, maxHeight: pos.maxHeight }}
          className="z-[70] overflow-y-auto rounded-md border border-ink-200 bg-white py-1 text-sm normal-case tracking-normal text-ink-800 shadow-lg"
          onMouseDown={(e) => e.preventDefault()}
        >
          {offerCustom && (
            <li
              className={clsx('cursor-pointer border-b border-ink-100 px-3 py-1.5 text-accent-700 hover:bg-accent-50', active === -1 && 'bg-accent-50')}
              onMouseEnter={() => { setActive(-1); hovered.current = true; }}
              onClick={() => { emit(query!.trim()); close(); }}
            >
              Use “{query!.trim()}”
            </li>
          )}
          {matches.length === 0 && !offerCustom && (
            <li className="px-3 py-1.5 text-xs italic text-ink-500">No option matches “{query}”.</li>
          )}
          {matches.map((o, i) => (
            <li
              key={`${o.value}|${i}`}
              id={`${listId}-${i}`}
              data-index={i}
              role="option"
              aria-selected={o.value === value}
              className={clsx(
                'cursor-pointer truncate px-3 py-1.5',
                i === active ? 'bg-accent-50 text-accent-900' : 'hover:bg-ink-50',
                o.value === value && 'font-semibold',
              )}
              title={o.label}
              onMouseEnter={() => { setActive(i); hovered.current = true; }}
              onClick={() => pick(o)}
            >
              {o.label || ' '}
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </div>
  );
}
