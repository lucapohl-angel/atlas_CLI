/** @jsxImportSource @opentui/react */
/**
 * Picker — generic centered overlay with a `<select>` list.
 *
 * Used by the Tab agent picker, Ctrl-O model picker, Ctrl-T thinking
 * picker, and Ctrl-P mode picker. Mirrors the Ink TUI's overlay
 * convention: single bordered box, accent border, title, hint line at
 * the bottom. Submitting (`enter`) calls `onChoose`; `escape` calls
 * `onCancel`.
 *
 * Positioning: rendered with absolute layout coordinates so it floats
 * over the chat without re-flowing it. The parent sets `zIndex` high
 * via stack order — OpenTUI doesn't have a true z-index, so the
 * picker is mounted last in the tree, after the chat layout.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TextareaRenderable } from '@opentui/core';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { palette } from './palette.js';

/**
 * Compute a centered, narrow overlay box position. Mirrors the Ink
 * TUI convention of *not* spanning the full terminal width — popups
 * read as modals, not as full-screen takeovers. Width caps at 72
 * cols (slightly wider than a typical email-line) and the box is
 * horizontally centered. When `rows` is supplied AND `height` is
 * set, the box is **vertically centered** as well; otherwise `top`
 * defaults to 2 to leave the header visible.
 */
const centeredOverlayStyle = (
  cols: number,
  opts?: {
    readonly top?: number;
    readonly maxWidth?: number;
    readonly rows?: number;
    readonly height?: number;
  }
): {
  readonly top: number;
  readonly left: number;
  readonly width: number;
} => {
  const max = opts?.maxWidth ?? 72;
  const width = Math.min(max, Math.max(40, cols - 4));
  const left = Math.max(2, Math.floor((cols - width) / 2));
  let top = opts?.top ?? 2;
  if (
    opts?.rows !== undefined &&
    opts?.height !== undefined &&
    opts.rows > opts.height
  ) {
    // Reserve 3 rows for the header + 1 for status bar.
    top = Math.max(3, Math.floor((opts.rows - opts.height) / 2));
  }
  return { top, left, width };
};

export interface PickerOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

/**
 * GroupedPickerEntry — either a non-selectable section header or an
 * actual picker item. Headers are rendered in-list (the OpenTUI
 * `<select>` widget has no native disabled/separator support, so we
 * include them as visually distinct items prefixed with `──`; on
 * Enter, the picker no-ops if the chosen value starts with `__hdr_`).
 */
export type GroupedPickerEntry =
  | { readonly kind: 'header'; readonly key: string; readonly label: string }
  | {
      readonly kind: 'item';
      readonly key: string;
      readonly label: string;
      readonly value: string;
      readonly description?: string;
      /**
       * When true, the row is highlighted as a "★ Popular" pick
       * (warning color when not selected). Mirrors the Ink TUI's
       * yellow tint on curated popular models.
       */
      readonly popular?: boolean;
    };

export interface PickerProps {
  readonly title: string;
  readonly options: readonly PickerOption[];
  readonly initialValue?: string;
  readonly onChoose: (value: string) => void;
  readonly onCancel: () => void;
  readonly hint?: string;
  /**
   * Optional override for the description column color. Defaults to
   * `palette.textMuted`. Pass `palette.success` for `• connected`
   * style status badges in /config.
   */
  readonly descriptionColor?: string;
}

export const Picker = (props: PickerProps) => {
  const { width: cols } = useTerminalDimensions();
  const pos = centeredOverlayStyle(cols);
  const items = useMemo(
    () =>
      props.options.map((o) => ({
        name: o.label,
        description: o.description ?? '',
        value: o.value
      })),
    [props.options]
  );
  const initialIndex = useMemo(() => {
    if (!props.initialValue) return 0;
    const i = props.options.findIndex((o) => o.value === props.initialValue);
    return i < 0 ? 0 : i;
  }, [props.options, props.initialValue]);

  // Cap height so the overlay never grows past ~half the screen even
  // for large model lists. The select component scrolls internally.
  const visibleRows = Math.min(items.length, 12);
  const showDescriptions = items.some((it) => it.description.length > 0);
  const rowHeight = showDescriptions ? 2 : 1;
  const selectHeight = Math.max(1, visibleRows * rowHeight);

  return (
    <box
      style={{
        position: 'absolute',
        top: pos.top,
        left: pos.left,
        width: pos.width,
        flexDirection: 'column',
        borderStyle: 'single',
        borderColor: palette.primary,
        backgroundColor: palette.backgroundElement,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 0,
        paddingBottom: 0
      }}
    >
      <box
        style={{
          flexDirection: 'row',
          backgroundColor: palette.backgroundElement
        }}
      >
        <text fg={palette.primaryBright}>{props.title}</text>
      </box>

      <select
        focused
        options={items}
        selectedIndex={initialIndex}
        showDescription={showDescriptions}
        wrapSelection
        style={{
          width: '100%',
          height: selectHeight,
          backgroundColor: palette.backgroundElement,
          focusedBackgroundColor: palette.backgroundElement,
          textColor: palette.text,
          focusedTextColor: palette.text,
          selectedBackgroundColor: palette.primary,
          selectedTextColor: palette.background,
          descriptionColor: props.descriptionColor ?? palette.textMuted,
          selectedDescriptionColor: palette.text
        }}
        onSelect={(_idx, opt) => {
          if (!opt) return;
          // SelectOption stores the label as `name`; we tucked the
          // real picker value into `value` via the items map above.
          const v = (opt as unknown as { value?: string }).value;
          if (typeof v === 'string') props.onChoose(v);
        }}
      />

      <box
        style={{
          flexDirection: 'row',
          backgroundColor: palette.backgroundElement,
          marginTop: 0
        }}
      >
        <text fg={palette.textMuted}>
          {props.hint ?? '↑/↓ navigate · ↵ choose · Esc cancel'}
        </text>
      </box>
    </box>
  );
};

export interface ConfirmProps {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly tone?: 'warn' | 'info';
}

/**
 * Confirm — small two-button overlay used for destructive or
 * elevated-permission flows (e.g. switching into autopilot). The
 * focused `<select>` exposes the two choices so the user can navigate
 * with arrow keys and confirm with Enter, mirroring the Ink TUI's
 * autopilot prompt UX.
 */
export const Confirm = (props: ConfirmProps) => {
  const { width: cols } = useTerminalDimensions();
  const pos = centeredOverlayStyle(cols, { maxWidth: 60 });
  const accent = props.tone === 'warn' ? palette.warning : palette.primary;
  return (
    <box
      style={{
        position: 'absolute',
        top: pos.top,
        left: pos.left,
        width: pos.width,
        flexDirection: 'column',
        borderStyle: 'single',
        borderColor: accent,
        backgroundColor: palette.backgroundElement,
        paddingLeft: 1,
        paddingRight: 1
      }}
    >
      <box style={{ flexDirection: 'row', backgroundColor: palette.backgroundElement }}>
        <text fg={accent}>{props.title}</text>
      </box>
      <box
        style={{
          flexDirection: 'row',
          backgroundColor: palette.backgroundElement,
          marginTop: 1,
          marginBottom: 1
        }}
      >
        <text fg={palette.text}>{props.message}</text>
      </box>
      <select
        focused
        options={[
          { name: props.cancelLabel ?? 'Cancel', description: 'Esc' },
          { name: props.confirmLabel ?? 'Continue', description: 'this is intentional' }
        ]}
        selectedIndex={0}
        showDescription
        style={{
          width: '100%',
          height: 4,
          backgroundColor: palette.backgroundElement,
          focusedBackgroundColor: palette.backgroundElement,
          textColor: palette.text,
          focusedTextColor: palette.text,
          selectedBackgroundColor: accent,
          selectedTextColor: palette.background,
          descriptionColor: palette.textMuted,
          selectedDescriptionColor: palette.text
        }}
        onSelect={(idx) => {
          if (idx === 1) props.onConfirm();
          else props.onCancel();
        }}
      />
    </box>
  );
};

export interface GroupedPickerProps {
  readonly title: string;
  readonly entries: readonly GroupedPickerEntry[];
  readonly initialValue?: string;
  readonly onChoose: (value: string) => void;
  readonly onCancel: () => void;
  readonly hint?: string;
}

/**
 * GroupedPicker — searchable list with section headers. Mirrors the
 * Ink TUI's grouped model picker (Anthropic / OpenAI Codex /
 * OpenRouter sections, with a "★ Popular" sub-header inside
 * OpenRouter).
 */
export const GroupedPicker = (props: GroupedPickerProps) => {
  const { width: cols } = useTerminalDimensions();
  const pos = centeredOverlayStyle(cols, { top: 1, maxWidth: 80 });
  const searchRef = useRef<TextareaRenderable | null>(null);

  const [filter, setFilter] = useState('');
  const [selectedValue, setSelectedValue] = useState<string | null>(
    props.initialValue ?? null
  );

  // Filter entries by label / value substring. Headers are emitted
  // only when their section has at least one matching item, so empty
  // sections collapse out of the list while typing.
  const filteredEntries = useMemo(() => {
    if (filter.length === 0) return props.entries;
    const q = filter.toLowerCase();
    const out: GroupedPickerEntry[] = [];
    let pendingHeader: GroupedPickerEntry | null = null;
    for (const e of props.entries) {
      if (e.kind === 'header') {
        pendingHeader = e;
        continue;
      }
      if (
        e.label.toLowerCase().includes(q) ||
        e.value.toLowerCase().includes(q)
      ) {
        if (pendingHeader) {
          out.push(pendingHeader);
          pendingHeader = null;
        }
        out.push(e);
      }
    }
    return out;
  }, [props.entries, filter]);

  const selectableEntries = useMemo(
    () => filteredEntries.filter((e): e is Extract<GroupedPickerEntry, { readonly kind: 'item' }> => e.kind === 'item'),
    [filteredEntries]
  );

  useEffect(() => {
    const first = selectableEntries[0]?.value ?? null;
    if (first === null) {
      if (selectedValue !== null) setSelectedValue(null);
      return;
    }
    if (!selectedValue || !selectableEntries.some((e) => e.value === selectedValue)) {
      setSelectedValue(first);
    }
  }, [selectableEntries, selectedValue]);

  const chooseSelected = useCallback((): void => {
    const chosen =
      selectableEntries.find((e) => e.value === selectedValue) ?? selectableEntries[0];
    if (chosen) props.onChoose(chosen.value);
  }, [props, selectableEntries, selectedValue]);

  useKeyboard((key) => {
    if (key.name === 'escape') {
      props.onCancel();
      return;
    }
    if (key.name !== 'up' && key.name !== 'down') return;
    if (selectableEntries.length === 0) return;
    const delta = key.name === 'up' ? -1 : 1;
    setSelectedValue((current) => {
      const currentIndex = Math.max(
        0,
        selectableEntries.findIndex((e) => e.value === current)
      );
      const nextIndex =
        (currentIndex + delta + selectableEntries.length) % selectableEntries.length;
      return selectableEntries[nextIndex]?.value ?? current;
    });
  });

  const selectedEntryIndex = Math.max(
    0,
    filteredEntries.findIndex(
      (e) => e.kind === 'item' && e.value === selectedValue
    )
  );
  const maxVisibleEntries = 16;
  const visibleStart = Math.max(
    0,
    Math.min(
      selectedEntryIndex - Math.floor(maxVisibleEntries / 2),
      Math.max(0, filteredEntries.length - maxVisibleEntries)
    )
  );
  const visibleEntries = filteredEntries.slice(visibleStart, visibleStart + maxVisibleEntries);
  const noMatches = filter.length > 0 && selectableEntries.length === 0;
  const hasMoreAbove = visibleStart > 0;
  const hasMoreBelow = visibleStart + maxVisibleEntries < filteredEntries.length;

  return (
    <box
      style={{
        position: 'absolute',
        top: pos.top,
        left: pos.left,
        width: pos.width,
        flexDirection: 'column',
        borderStyle: 'single',
        borderColor: palette.primary,
        backgroundColor: palette.backgroundElement,
        paddingLeft: 1,
        paddingRight: 1
      }}
    >
      <box style={{ flexDirection: 'row', backgroundColor: palette.backgroundElement }}>
        <text fg={palette.primaryBright}>{props.title}</text>
      </box>
      <box
        style={{
          flexDirection: 'row',
          backgroundColor: palette.backgroundElement,
          borderStyle: 'single',
          borderColor: palette.border,
          paddingLeft: 1,
          paddingRight: 1,
          marginTop: 1,
          marginBottom: 1
        }}
      >
        <text fg={palette.textMuted}>search </text>
        <textarea
          ref={searchRef}
          focused
          placeholder="type a model name"
          placeholderColor={palette.textDim}
          backgroundColor={palette.backgroundElement}
          focusedBackgroundColor={palette.backgroundElement}
          textColor={palette.text}
          focusedTextColor={palette.text}
          cursorColor={palette.primaryBright}
          wrapMode="char"
          keyBindings={[{ name: 'return', action: 'submit' }]}
          onContentChange={() => {
            setFilter((searchRef.current?.plainText ?? '').replace(/\r?\n/g, ' '));
          }}
          onSubmit={chooseSelected}
          style={{ width: '100%', height: 1 }}
        />
      </box>
      {noMatches ? (
        <box
          style={{
            flexDirection: 'row',
            backgroundColor: palette.backgroundElement
          }}
        >
          <text fg={palette.warning}>{`no matches for "${filter}"`}</text>
        </box>
      ) : (
        <box
          style={{
            width: '100%',
            flexDirection: 'column',
            backgroundColor: palette.backgroundElement,
            height: Math.max(1, visibleEntries.length * 2)
          }}
        >
          {visibleEntries.map((entry) => {
            if (entry.kind === 'header') {
              return (
                <box
                  key={entry.key}
                  style={{ flexDirection: 'row', backgroundColor: palette.backgroundElement }}
                >
                  <text fg={palette.primaryBright}>{entry.label}</text>
                </box>
              );
            }
            const selected = entry.value === selectedValue;
            const bg = selected ? palette.primary : palette.backgroundElement;
            const fg = selected
              ? palette.background
              : entry.popular
                ? palette.warning
                : palette.text;
            return (
              <box
                key={entry.key}
                style={{ flexDirection: 'column', backgroundColor: bg }}
              >
                <text fg={fg}>{`${selected ? '>' : ' '} ${entry.label}`}</text>
                <text fg={selected ? palette.text : palette.textMuted}>
                  {`  ${entry.description ?? ''}`}
                </text>
              </box>
            );
          })}
        </box>
      )}
      <box style={{ flexDirection: 'row', backgroundColor: palette.backgroundElement }}>
        <text fg={palette.textMuted}>
          {props.hint ?? 'type to filter · ↑/↓ navigate · ↵ choose · Esc cancel'}
          {hasMoreAbove || hasMoreBelow
            ? ` · showing ${visibleStart + 1}-${visibleStart + visibleEntries.length} of ${filteredEntries.length}`
            : ''}
        </text>
      </box>
    </box>
  );
};

export interface KeyEntryProps {
  readonly title: string;
  readonly help: string;
  readonly placeholder?: string;
  readonly mask?: boolean;
  readonly onSubmit: (value: string) => void;
  readonly onCancel: () => void;
  readonly errorMessage?: string;
}

/**
 * KeyEntry — single-line text input overlay used by /config for API
 * key entry. Enter submits, Esc cancels at the parent layer.
 */
export const KeyEntry = (props: KeyEntryProps) => {
  const { width: cols } = useTerminalDimensions();
  const pos = centeredOverlayStyle(cols, { maxWidth: 64 });
  const ref = useRef<TextareaRenderable | null>(null);
  return (
    <box
      style={{
        position: 'absolute',
        top: pos.top,
        left: pos.left,
        width: pos.width,
        flexDirection: 'column',
        borderStyle: 'double',
        borderColor: palette.primary,
        backgroundColor: palette.backgroundElement,
        paddingLeft: 1,
        paddingRight: 1
      }}
    >
      <box style={{ flexDirection: 'row', backgroundColor: palette.backgroundElement }}>
        <text fg={palette.primaryBright}>{props.title}</text>
      </box>
      <box
        style={{
          flexDirection: 'column',
          marginTop: 1,
          marginBottom: 1,
          backgroundColor: palette.backgroundElement
        }}
      >
        {props.help.split('\n').map((ln, i) => (
          <text key={`h${i}`} fg={palette.textMuted}>{ln}</text>
        ))}
      </box>
      {props.errorMessage ? (
        <box style={{ flexDirection: 'row', backgroundColor: palette.backgroundElement }}>
          <text fg={palette.error}>{`error: ${props.errorMessage}`}</text>
        </box>
      ) : null}
      <box
        style={{
          flexDirection: 'row',
          marginTop: 1,
          backgroundColor: palette.backgroundElement,
          borderColor: palette.primary,
          borderStyle: 'single',
          paddingLeft: 1,
          paddingRight: 1
        }}
      >
        <textarea
          ref={ref}
          focused
          placeholder={props.placeholder ?? ''}
          placeholderColor={palette.textDim}
          backgroundColor={palette.backgroundElement}
          focusedBackgroundColor={palette.backgroundElement}
          textColor={props.mask ? palette.backgroundElement : palette.text}
          focusedTextColor={props.mask ? palette.backgroundElement : palette.text}
          cursorColor={palette.primaryBright}
          wrapMode="char"
          keyBindings={[{ name: 'return', action: 'submit' }]}
          onSubmit={() => {
            const v = (ref.current?.plainText ?? '').trim();
            if (v.length > 0) props.onSubmit(v);
          }}
          style={{ width: '100%', height: 1 }}
        />
      </box>
      <box style={{ flexDirection: 'row', backgroundColor: palette.backgroundElement }}>
        <text fg={palette.textMuted}>
          {props.mask
            ? '↵ save (your input is hidden) · Esc cancel'
            : '↵ save · Esc cancel'}
        </text>
      </box>
    </box>
  );
};

export interface InfoOverlayProps {
  readonly title: string;
  readonly body: string;
  readonly onClose: () => void;
  readonly tone?: 'info' | 'warn' | 'error';
}

/**
 * InfoOverlay — read-only modal used by /config branches that don't
 * need user input. Press Enter / Esc to dismiss.
 */
export const InfoOverlay = (props: InfoOverlayProps) => {
  const { width: cols } = useTerminalDimensions();
  const pos = centeredOverlayStyle(cols, { maxWidth: 64 });
  const accent =
    props.tone === 'warn'
      ? palette.warning
      : props.tone === 'error'
        ? palette.error
        : palette.primary;
  const lines = props.body.split('\n');
  return (
    <box
      style={{
        position: 'absolute',
        top: pos.top,
        left: pos.left,
        width: pos.width,
        flexDirection: 'column',
        borderStyle: 'single',
        borderColor: accent,
        backgroundColor: palette.backgroundElement,
        paddingLeft: 1,
        paddingRight: 1
      }}
    >
      <box style={{ flexDirection: 'row', backgroundColor: palette.backgroundElement }}>
        <text fg={accent}>{props.title}</text>
      </box>
      <box
        style={{
          flexDirection: 'column',
          marginTop: 1,
          marginBottom: 1,
          backgroundColor: palette.backgroundElement
        }}
      >
        {lines.map((ln, i) => (
          <text key={`l${i}`} fg={palette.text}>{ln}</text>
        ))}
      </box>
      <select
        focused
        options={[{ name: 'OK', description: '↵ / Esc to close' }]}
        selectedIndex={0}
        showDescription
        style={{
          width: '100%',
          height: 2,
          backgroundColor: palette.backgroundElement,
          focusedBackgroundColor: palette.backgroundElement,
          textColor: palette.text,
          focusedTextColor: palette.text,
          selectedBackgroundColor: accent,
          selectedTextColor: palette.background,
          descriptionColor: palette.textMuted,
          selectedDescriptionColor: palette.text
        }}
        onSelect={() => props.onClose()}
      />
    </box>
  );
};

export interface MultiSelectItem {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface MultiSelectAction {
  readonly value: string;
  readonly label: string;
  /** Description rendered under the action when it's the active one. */
  readonly hint?: string;
}

export interface MultiSelectProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly items: readonly MultiSelectItem[];
  /** Set of item values that should start checked. Defaults to all checked. */
  readonly initiallySelected?: ReadonlySet<string>;
  readonly actions: readonly MultiSelectAction[];
  /**
   * Called when the user picks an action. `selected` contains the
   * currently-checked item values, `action` is the picked action's
   * `value`. Caller decides what each action means.
   */
  readonly onSubmit: (selected: readonly string[], action: string) => void;
  readonly onCancel?: () => void;
  /** Optional footer line — usually a token estimate or context hint. */
  readonly footer?: string;
}

/**
 * MultiSelect — checkbox list + action row in a single overlay.
 *
 * Two-mode keyboard handling: when the cursor is on the items list,
 * `Space` toggles, `↑/↓` navigate, `a` selects all, `n` clears all.
 * `Tab` (or `↓` from the last item) drops focus into the action row;
 * `Tab`/`←/→` rotate actions, `Enter` invokes the active one. This
 * is a light reimplementation of the multi-select pattern Atlas's
 * Ink TUI does *not* expose — OpenTUI's native `<select>` only
 * does single-select.
 */
export const MultiSelect = (props: MultiSelectProps) => {
  const { width: cols, height: rows } = useTerminalDimensions();
  const overlayWidth = Math.min(96, Math.max(60, cols - 4));
  const overlayHeight = Math.min(28, Math.max(16, rows - 4));
  const left = Math.max(2, Math.floor((cols - overlayWidth) / 2));
  const top = Math.max(2, Math.floor((rows - overlayHeight) / 2));
  const itemRows = Math.max(4, overlayHeight - (props.subtitle ? 9 : 8) - (props.footer ? 1 : 0));
  const [cursor, setCursor] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [actionIdx, setActionIdx] = useState(0);
  const [focus, setFocus] = useState<'items' | 'actions'>('items');
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () =>
      props.initiallySelected ??
      new Set(props.items.map((i) => i.value))
  );

  // Keep cursor in view when it moves.
  useEffect(() => {
    if (cursor < scroll) setScroll(cursor);
    else if (cursor >= scroll + itemRows) setScroll(cursor - itemRows + 1);
  }, [cursor, scroll, itemRows]);

  useKeyboard((key) => {
    if (key.name === 'escape') {
      props.onCancel?.();
      return;
    }
    if (focus === 'items') {
      if (key.name === 'up') {
        setCursor((c) => (c - 1 + props.items.length) % props.items.length);
        return;
      }
      if (key.name === 'down') {
        if (cursor === props.items.length - 1) {
          setFocus('actions');
          return;
        }
        setCursor((c) => Math.min(props.items.length - 1, c + 1));
        return;
      }
      if (key.name === 'pageup') {
        setCursor((c) => Math.max(0, c - itemRows));
        return;
      }
      if (key.name === 'pagedown') {
        setCursor((c) => Math.min(props.items.length - 1, c + itemRows));
        return;
      }
      if (key.name === 'home') {
        setCursor(0);
        return;
      }
      if (key.name === 'end') {
        setCursor(props.items.length - 1);
        return;
      }
      if (key.sequence === ' ' || key.name === 'space') {
        const v = props.items[cursor]?.value;
        if (!v) return;
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(v)) next.delete(v);
          else next.add(v);
          return next;
        });
        return;
      }
      if (key.sequence === 'a') {
        setSelected(new Set(props.items.map((i) => i.value)));
        return;
      }
      if (key.sequence === 'n') {
        setSelected(new Set());
        return;
      }
      if (key.name === 'tab') {
        setFocus('actions');
        return;
      }
      if (key.name === 'return') {
        // Enter on an item is treated as "submit with the primary action".
        setFocus('actions');
        return;
      }
      return;
    }
    // focus === 'actions'
    if (key.name === 'tab' || key.name === 'right' || key.name === 'down') {
      setActionIdx((i) => (i + 1) % props.actions.length);
      return;
    }
    if (key.name === 'left') {
      setActionIdx((i) => (i - 1 + props.actions.length) % props.actions.length);
      return;
    }
    if (key.name === 'up') {
      setFocus('items');
      return;
    }
    if (key.name === 'return') {
      const a = props.actions[actionIdx];
      if (a) props.onSubmit([...selected], a.value);
      return;
    }
  });

  const visible = props.items.slice(scroll, scroll + itemRows);
  const activeAction = props.actions[actionIdx];
  return (
    <box
      style={{
        position: 'absolute',
        top,
        left,
        width: overlayWidth,
        height: overlayHeight,
        flexDirection: 'column',
        borderStyle: 'single',
        borderColor: palette.primary,
        backgroundColor: palette.backgroundElement,
        paddingLeft: 1,
        paddingRight: 1
      }}
    >
      <text fg={palette.primaryBright}>{props.title}</text>
      {props.subtitle ? (
        <text fg={palette.textMuted}>{props.subtitle}</text>
      ) : null}
      <box
        style={{
          flexDirection: 'column',
          height: itemRows,
          marginTop: 1,
          marginBottom: 1,
          backgroundColor: palette.backgroundPanel,
          paddingLeft: 1,
          paddingRight: 1
        }}
      >
        {visible.map((it, i) => {
          const absIdx = scroll + i;
          const isCursor = focus === 'items' && absIdx === cursor;
          const isChecked = selected.has(it.value);
          const glyph = isChecked ? '[x]' : '[ ]';
          const glyphColor = isChecked ? palette.success : palette.textMuted;
          const labelColor = isCursor ? palette.background : palette.text;
          const descColor = isCursor ? palette.background : palette.textDim;
          return (
            <box
              key={`ms-${it.value}-${absIdx}`}
              style={{
                flexDirection: 'row',
                backgroundColor: isCursor ? palette.primary : palette.backgroundPanel
              }}
            >
              <text fg={isCursor ? palette.background : glyphColor}>
                {`${glyph} `}
              </text>
              <text fg={labelColor}>{it.label}</text>
              {it.description ? (
                <text fg={descColor}>{`  ${it.description}`}</text>
              ) : null}
            </box>
          );
        })}
      </box>
      <box
        style={{
          flexDirection: 'row',
          backgroundColor: palette.backgroundElement
        }}
      >
        <text fg={palette.textMuted}>
          {`${selected.size}/${props.items.length} selected · ${cursor + 1}/${props.items.length}`}
        </text>
      </box>
      <box
        style={{
          flexDirection: 'row',
          backgroundColor: palette.backgroundElement,
          marginTop: 1
        }}
      >
        {props.actions.map((a, i) => {
          const isActive = focus === 'actions' && i === actionIdx;
          return (
            <box
              key={`ms-action-${a.value}`}
              style={{
                flexDirection: 'row',
                backgroundColor: isActive ? palette.primary : palette.backgroundElement,
                marginRight: 1
              }}
            >
              <text fg={isActive ? palette.background : palette.text}>
                {` ${a.label} `}
              </text>
            </box>
          );
        })}
      </box>
      {focus === 'actions' && activeAction?.hint ? (
        <text fg={palette.textMuted}>{activeAction.hint}</text>
      ) : null}
      {props.footer ? (
        <text fg={palette.textDim}>{props.footer}</text>
      ) : null}
      <text fg={palette.textMuted}>
        {focus === 'items'
          ? '↑/↓ move · Space toggle · a/n all/none · Tab → actions · Esc cancel'
          : 'Tab/←/→ action · ↑ back to list · ↵ confirm · Esc cancel'}
      </text>
    </box>
  );
};

export interface LoadingOverlayProps {
  readonly title: string;
  /** Static body text. Updated dynamically by the parent on each render. */
  readonly body: string;
  /** Optional second-line hint, e.g. "Esc / Ctrl-C cancel". */
  readonly hint?: string;
  /** Tone affects border + spinner color. Defaults to 'info' (primary). */
  readonly tone?: 'info' | 'warn' | 'error';
}

const LOADING_SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/**
 * LoadingOverlay — non-dismissable modal for in-progress async work.
 * Differs from `InfoOverlay` by not rendering a select / OK button —
 * the user can't "close" something that's still running. Includes a
 * braille spinner that ticks every 80 ms so the panel reads as live
 * even when the body text is static.
 */
export const LoadingOverlay = (props: LoadingOverlayProps) => {
  const { width: cols } = useTerminalDimensions();
  const pos = centeredOverlayStyle(cols, { maxWidth: 64 });
  const [spinIdx, setSpinIdx] = useState(0);
  useEffect(() => {
    const id = setInterval(
      () => setSpinIdx((i) => (i + 1) % LOADING_SPIN_FRAMES.length),
      80
    );
    return () => clearInterval(id);
  }, []);
  const accent =
    props.tone === 'warn'
      ? palette.warning
      : props.tone === 'error'
        ? palette.error
        : palette.primary;
  const lines = props.body.split('\n');
  return (
    <box
      style={{
        position: 'absolute',
        top: pos.top,
        left: pos.left,
        width: pos.width,
        flexDirection: 'column',
        borderStyle: 'single',
        borderColor: accent,
        backgroundColor: palette.backgroundElement,
        paddingLeft: 1,
        paddingRight: 1
      }}
    >
      <box style={{ flexDirection: 'row', backgroundColor: palette.backgroundElement }}>
        <text fg={accent}>{`${LOADING_SPIN_FRAMES[spinIdx]} ${props.title}`}</text>
      </box>
      <box
        style={{
          flexDirection: 'column',
          marginTop: 1,
          marginBottom: 1,
          backgroundColor: palette.backgroundElement
        }}
      >
        {lines.map((ln, i) => (
          <text key={`l${i}`} fg={palette.text}>{ln}</text>
        ))}
      </box>
      {props.hint ? (
        <text fg={palette.textMuted}>{props.hint}</text>
      ) : null}
    </box>
  );
};

export interface SlashSuggestion {
  readonly name: string;
  readonly summary: string;
}

export interface SlashAutocompleteProps {
  readonly suggestions: readonly SlashSuggestion[];
  readonly highlightIndex: number;
  /**
   * If we have more matches than visible rows, the popup scrolls
   * to keep the highlighted row in view. Caller passes the offset.
   */
  readonly scrollOffset?: number;
  readonly maxVisible?: number;
  /**
   * Anchor row from the bottom of the screen. The popup floats just
   * above the composer (which sits at `bottom: 1` for the status
   * bar + `height: 3` for itself + 1 row gap).
   */
  readonly bottom?: number;
  /**
   * Left offset relative to the parent (Body). Defaults to 0 so the
   * popup sits flush with the chat column's left edge — same as the
   * composer it's anchored above.
   */
  readonly left?: number;
  /**
   * Width override. When supplied, the popup matches the composer
   * width exactly (the user wants the autocomplete to read like a
   * dropdown that opens *from* the chat bar).
   */
  readonly width?: number;
}

/**
 * SlashAutocomplete — inline command-name dropdown that appears above
 * the composer when the user types `/` (no space yet). Mirrors the
 * Ink TUI's SlashAutocomplete component (App.tsx:6908). The rendering
 * is non-interactive (no focus stolen from the composer); the parent
 * App handles ↑/↓ Tab Enter via the global keyboard listener and
 * passes back `highlightIndex`.
 */
export const SlashAutocomplete = (props: SlashAutocompleteProps) => {
  const { width: cols } = useTerminalDimensions();
  const max = props.maxVisible ?? 8;
  const total = props.suggestions.length;
  if (total === 0) return null;
  // Auto-scroll: keep highlightIndex within [offset, offset+max).
  const auto =
    props.scrollOffset ??
    (props.highlightIndex < max
      ? 0
      : Math.min(total - max, props.highlightIndex - max + 1));
  const offset = Math.max(0, Math.min(Math.max(0, total - max), auto));
  const visible = props.suggestions.slice(offset, offset + max);
  // Default: anchor above composer (3 rows for composer + 1 for status bar).
  const bottom = props.bottom ?? 4;
  const width = Math.max(40, props.width ?? Math.min(cols - 4, 80));
  const left = props.left ?? Math.max(0, Math.floor((cols - width) / 2));
  const longestName = visible.reduce(
    (acc, s) => Math.max(acc, s.name.length + 1),
    0
  );
  return (
    <box
      style={{
        position: 'absolute',
        bottom,
        left,
        width,
        flexDirection: 'column',
        borderStyle: 'single',
        borderColor: palette.primary,
        backgroundColor: palette.backgroundPanel,
        paddingLeft: 1,
        paddingRight: 1
      }}
    >
      {visible.map((s, idx) => {
        const realIdx = offset + idx;
        const active = realIdx === props.highlightIndex;
        const prefix = active ? '❯ ' : '  ';
        const nameColor = active ? palette.primaryBright : palette.primary;
        const descColor = active ? palette.text : palette.textMuted;
        // Pad the slash command name so descriptions line up across
        // rows, mirroring the Ink TUI's column alignment.
        const padded = `/${s.name}`.padEnd(longestName + 1);
        return (
          <box
            key={`s-${s.name}`}
            style={{
              flexDirection: 'row',
              backgroundColor: palette.backgroundPanel
            }}
          >
            <text fg={nameColor}>{prefix + padded}</text>
            <text fg={descColor}>{s.summary}</text>
          </box>
        );
      })}
      <box
        style={{
          flexDirection: 'row',
          backgroundColor: palette.backgroundPanel,
          marginTop: 0
        }}
      >
        <text fg={palette.textDim}>
          {`↑↓ select · Tab complete · ↵ run${total > max ? `  ·  ${props.highlightIndex + 1}/${total}` : ''}`}
        </text>
      </box>
    </box>
  );
};


export interface ColoredGroupedPickerProps {
  readonly title: string;
  readonly entries: readonly GroupedPickerEntry[];
  readonly initialValue?: string;
  readonly onChoose: (value: string) => void;
  readonly onCancel: () => void;
  readonly hint?: string;
  /**
   * Optional max visible rows (default 14). Lists longer than this
   * scroll to keep the cursor in view.
   */
  readonly maxVisible?: number;
}

/**
 * ColoredGroupedPicker — like GroupedPicker but renders each row
 * with explicit per-row foreground colors so we can mirror the Ink
 * TUI's palette:
 *   - Headers (Anthropic / OpenAI / OpenRouter / ★ Popular):
 *       palette.accent (magenta)  bold
 *   - Popular items (unselected):     palette.warning (yellow)  ★
 *   - Selected row:                   palette.success (green)   ❯
 *       (or palette.primaryBright when selected on a popular row)
 *   - Normal items:                   palette.text
 *
 * The OpenTUI `<select>` renderer applies a single foreground color
 * to every row, so we can't get this look from `<select>`. We render
 * a vertical stack of `<text>` rows ourselves, track the cursor with
 * `useState`, and listen to ↑/↓/PgUp/PgDn/Home/End/Enter/Esc via
 * `useKeyboard`. ↑/↓ skip header rows automatically.
 */
export const ColoredGroupedPicker = (props: ColoredGroupedPickerProps) => {
  const { width: cols, height: termRows } = useTerminalDimensions();
  const max = Math.max(4, Math.min(props.maxVisible ?? 14, Math.max(4, termRows - 9)));
  // Box height = title + search + visible rows + hint + border/pad.
  const boxHeight = max + 8;
  const pos = centeredOverlayStyle(cols, {
    top: 1,
    maxWidth: 84,
    rows: termRows,
    height: boxHeight
  });

  const [filter, setFilter] = useState('');
  const normalizedFilter = filter.trim().toLowerCase();
  const rows = useMemo(() => {
    if (normalizedFilter.length === 0) return props.entries;
    const nextRows: GroupedPickerEntry[] = [];
    let pendingHeader: Extract<GroupedPickerEntry, { readonly kind: 'header' }> | null = null;
    for (const entry of props.entries) {
      if (entry.kind === 'header') {
        pendingHeader = entry;
        continue;
      }
      const description = entry.description ?? '';
      const matches =
        entry.label.toLowerCase().includes(normalizedFilter) ||
        entry.value.toLowerCase().includes(normalizedFilter) ||
        description.toLowerCase().includes(normalizedFilter);
      if (!matches) continue;
      if (pendingHeader) {
        nextRows.push(pendingHeader);
        pendingHeader = null;
      }
      nextRows.push(entry);
    }
    return nextRows;
  }, [props.entries, normalizedFilter]);
  const itemIndices = useMemo(
    () =>
      rows
        .map((r, i) => (r.kind === 'item' ? i : -1))
        .filter((i) => i >= 0),
    [rows]
  );
  const initialItemIdx = useMemo(() => {
    if (itemIndices.length === 0) return 0;
    if (!props.initialValue) return itemIndices[0] ?? 0;
    const found = rows.findIndex(
      (r) => r.kind === 'item' && r.value === props.initialValue
    );
    return found >= 0 ? found : (itemIndices[0] ?? 0);
  }, [rows, itemIndices, props.initialValue]);

  const [cursor, setCursor] = useState<number>(initialItemIdx);
  const [scrollOffset, setScrollOffset] = useState<number>(0);

  useEffect(() => {
    setCursor(initialItemIdx);
    setScrollOffset(0);
  }, [normalizedFilter, initialItemIdx]);

  // Auto-scroll: keep the visible window covering the cursor. We
  // also clamp generously when wrapping (cursor jumped from end →
  // start), pinning the window to either start or end. When the
  // cursor lands on the first item of a section, walk back to
  // include the section header so the user always sees which group
  // they're in.
  useEffect(() => {
    setScrollOffset((off) => {
      let next = off;
      if (cursor < next) next = cursor;
      else if (cursor >= next + max) next = Math.max(0, cursor - max + 1);
      // Pull in preceding headers so the section title stays visible.
      while (next > 0 && rows[next - 1]?.kind === 'header') next -= 1;
      return next;
    });
  }, [cursor, max, rows]);

  // Wrap-aware item navigation. Direction +1 (down) wraps from the
  // last item back to the first; -1 (up) wraps from the first item
  // back to the last. Headers are skipped automatically because the
  // wrap target is always an item index from `itemIndices`.
  const stepItem = (dir: 1 | -1): void => {
    if (itemIndices.length === 0) return;
    // Find current cursor's index in itemIndices (or nearest).
    let pos = itemIndices.indexOf(cursor);
    if (pos < 0) {
      // Cursor is on a header — find the next item in the requested
      // direction, no wrap needed for that first hop.
      pos = dir === 1
        ? itemIndices.findIndex((i) => i > cursor)
        : (() => {
            for (let k = itemIndices.length - 1; k >= 0; k -= 1) {
              const v = itemIndices[k];
              if (v !== undefined && v < cursor) return k;
            }
            return -1;
          })();
      if (pos < 0) pos = dir === 1 ? 0 : itemIndices.length - 1;
      const next = itemIndices[pos];
      if (typeof next === 'number') setCursor(next);
      return;
    }
    const nextPos = (pos + dir + itemIndices.length) % itemIndices.length;
    const next = itemIndices[nextPos];
    if (typeof next === 'number') setCursor(next);
  };

  useKeyboard((key) => {
    if (key.name === 'escape') {
      props.onCancel();
      return;
    }
    if (key.ctrl && key.name === 'u') {
      setFilter('');
      return;
    }
    if (key.name === 'backspace' || key.name === 'delete') {
      setFilter((current) => current.slice(0, -1));
      return;
    }
    if (
      typeof key.sequence === 'string' &&
      key.sequence.length === 1 &&
      !key.ctrl &&
      !key.meta &&
      key.sequence.charCodeAt(0) >= 0x20
    ) {
      setFilter((current) => current + key.sequence);
      return;
    }
    if (key.name === 'return') {
      const r = rows[cursor];
      if (r && r.kind === 'item') props.onChoose(r.value);
      return;
    }
    if (key.name === 'up') {
      stepItem(-1);
      return;
    }
    if (key.name === 'down') {
      stepItem(1);
      return;
    }
    if (key.name === 'pageup') {
      // Page up = N steps; wrap-aware via stepItem.
      for (let i = 0; i < max; i += 1) stepItem(-1);
      return;
    }
    if (key.name === 'pagedown') {
      for (let i = 0; i < max; i += 1) stepItem(1);
      return;
    }
    if (key.name === 'home') {
      const first = itemIndices[0];
      if (typeof first === 'number') setCursor(first);
      return;
    }
    if (key.name === 'end') {
      const last = itemIndices[itemIndices.length - 1];
      if (typeof last === 'number') setCursor(last);
      return;
    }
  });

  const visible = rows.slice(scrollOffset, scrollOffset + max);
  const totalItems = itemIndices.length;
  const itemPosition =
    rows[cursor]?.kind === 'item'
      ? itemIndices.indexOf(cursor) + 1
      : 0;

  return (
    <box
      style={{
        position: 'absolute',
        top: pos.top,
        left: pos.left,
        width: pos.width,
        flexDirection: 'column',
        borderStyle: 'single',
        borderColor: palette.primary,
        backgroundColor: palette.backgroundElement,
        paddingLeft: 1,
        paddingRight: 1
      }}
    >
      <box
        style={{
          flexDirection: 'row',
          backgroundColor: palette.backgroundElement
        }}
      >
        <text fg={palette.primaryBright}>{props.title}</text>
      </box>
      <box
        style={{
          flexDirection: 'row',
          backgroundColor: palette.backgroundPanel,
          borderStyle: 'single',
          borderColor: palette.border,
          paddingLeft: 1,
          paddingRight: 1,
          marginTop: 1,
          marginBottom: 1
        }}
      >
        <text fg={filter.length > 0 ? palette.text : palette.textMuted}>
          {filter.length > 0 ? `search: ${filter}_` : 'search: type a model name'}
        </text>
      </box>
      {itemIndices.length === 0 && filter.length > 0 ? (
        <box
          style={{
            flexDirection: 'row',
            backgroundColor: palette.backgroundElement
          }}
        >
          <text fg={palette.warning}>{`no matches for "${filter}"`}</text>
        </box>
      ) : null}
      {visible.map((row, rowIndex) => {
        const realIdx = scrollOffset + rowIndex;
        const active = realIdx === cursor;
        if (row.kind === 'header') {
          return (
            <box
              key={`h-${row.key}-${realIdx}`}
              style={{
                flexDirection: 'row',
                backgroundColor: palette.backgroundElement,
                marginTop: realIdx === 0 ? 0 : 1
              }}
            >
              <text fg={palette.accent}>{`── ${row.label} ──`}</text>
            </box>
          );
        }
        const popular = row.popular === true;
        const prefix = active ? '❯ ' : popular ? '★ ' : '  ';
        const baseColor = popular ? palette.warning : palette.text;
        const fg = active ? palette.success : baseColor;
        const descFg = active ? palette.text : palette.textMuted;
        const desc = row.description ?? '';
        // Truncate the visible row to the inner width so long ids
        // don't wrap (which would break our 1-row-per-entry math).
        const inner = Math.max(20, pos.width - 4);
        const labelMax = Math.max(10, inner - desc.length - 3);
        const label =
          row.label.length > labelMax
            ? row.label.slice(0, labelMax - 1) + '…'
            : row.label;
        return (
          <box
            key={`i-${row.key}-${realIdx}`}
            style={{
              flexDirection: 'row',
              backgroundColor: active
                ? palette.backgroundPanel
                : palette.backgroundElement
            }}
          >
            <text fg={fg}>{prefix + label}</text>
            {desc.length > 0 ? (
              <text fg={descFg}>{`  ${desc}`}</text>
            ) : null}
          </box>
        );
      })}
      <box
        style={{
          flexDirection: 'row',
          backgroundColor: palette.backgroundElement,
          marginTop: 1
        }}
      >
        <text fg={palette.textMuted}>
          {props.hint ??
            `type to filter · ↑/↓ navigate · ↵ choose · Ctrl-U clear · Esc cancel${totalItems > 0 ? `  ·  ${itemPosition}/${totalItems}` : ''}`}
        </text>
      </box>
    </box>
  );
};
