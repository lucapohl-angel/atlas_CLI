/** @jsxImportSource @opentui/react */
/**
 * Inline markdown renderer for OpenTUI `<text>` nodes.
 *
 * OpenTUI's `<text>` node only accepts plain strings as children — no
 * nested `<text>` allowed (the renderer throws). The trick is to put
 * sibling `<text>` nodes inside a row-flex `<box>` so each segment
 * can carry its own style props while still flowing inline.
 *
 * We support the four markup shapes the model emits most often:
 *   - **bold**          → bold weight
 *   - *italic*          → italic
 *   - `code`            → mono color + dim background hint
 *   - ~~strike~~        → underline (closest readable analog)
 *
 * Anything outside these tokens is emitted as a plain `<text>` with
 * the caller-supplied default color.
 */
import type { ReactNode } from 'react';
import { createTextAttributes } from '@opentui/core';
import { palette } from './palette.js';

interface Segment {
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly mono?: boolean;
}

const BOLD_ATTR = createTextAttributes({ bold: true });
const ITALIC_ATTR = createTextAttributes({ italic: true });
const UNDERLINE_ATTR = createTextAttributes({ underline: true });
const HEADING_ATTR = createTextAttributes({ bold: true });

const TOKEN = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|~~[^~\n]+~~)/g;

const tokenize = (line: string): readonly Segment[] => {
  if (!line) return [];
  const out: Segment[] = [];
  let last = 0;
  for (const m of line.matchAll(TOKEN)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ text: line.slice(last, idx) });
    const tok = m[0];
    if (tok.startsWith('**')) {
      out.push({ text: tok.slice(2, -2), bold: true });
    } else if (tok.startsWith('`')) {
      out.push({ text: tok.slice(1, -1), mono: true });
    } else if (tok.startsWith('~~')) {
      out.push({ text: tok.slice(2, -2), underline: true });
    } else {
      out.push({ text: tok.slice(1, -1), italic: true });
    }
    last = idx + tok.length;
  }
  if (last < line.length) out.push({ text: line.slice(last) });
  return out;
};

/**
 * Render one logical line as an inline row of styled segments.
 *
 * Whole-line shapes (heading hashes, list bullets, fenced-code
 * markers) are NOT handled here — the caller is expected to slice
 * the text into lines first and decide whether each line is plain,
 * a heading, a code-block line, etc. before calling this.
 */
export const renderInlineMarkdown = (
  line: string,
  defaultColor: string,
  keyPrefix: string
): ReactNode => {
  const segments = tokenize(line);
  if (segments.length === 0) {
    return (
      <box
        key={keyPrefix}
        style={{
          flexDirection: 'row',
          backgroundColor: palette.backgroundPanel
        }}
      >
        <text fg={defaultColor}> </text>
      </box>
    );
  }
  return (
    <box
      key={keyPrefix}
      style={{
        flexDirection: 'row',
        backgroundColor: palette.backgroundPanel,
        flexWrap: 'wrap'
      }}
    >
      {segments.map((seg, i) => {
        const fg = seg.mono
          ? palette.warning
          : defaultColor;
        const attrs = seg.bold
          ? BOLD_ATTR
          : seg.italic
            ? ITALIC_ATTR
            : seg.underline
              ? UNDERLINE_ATTR
              : 0;
        return (
          <text key={`${keyPrefix}_${i}`} fg={fg} attributes={attrs}>
            {seg.text}
          </text>
        );
      })}
    </box>
  );
};

/**
 * Render a multi-line string as a column of inline-markdown rows.
 * Headings (`# `, `## `, `### `) are rendered with the accent color
 * and bold; list bullets and numbered list markers are kept as plain
 * text so the indentation reads correctly. Triple-backtick fenced
 * code blocks are batched into a contrasting block (raised tile
 * background + monospace warning color) so file contents and shell
 * snippets stand apart from prose at a glance.
 */
export const renderMarkdownBlock = (
  text: string,
  defaultColor: string,
  keyPrefix: string
): ReactNode => {
  const lines = text.split('\n');
  // First pass: walk through the lines and group consecutive
  // fenced-code-block lines together. Output is a heterogeneous
  // list of either `{kind:'md', line}` or
  // `{kind:'code', lines, lang}` blocks. We render in a second
  // pass so each code block becomes a single visually-grouped tile
  // instead of N independent rows that the layout could split.
  type Block =
    | { readonly kind: 'md'; readonly line: string; readonly idx: number }
    | { readonly kind: 'code'; readonly lines: readonly string[]; readonly lang: string; readonly idx: number };
  const blocks: Block[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let codeLang = '';
  let codeStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const fence = /^```(.*)$/.exec(raw);
    if (fence) {
      if (!inCode) {
        inCode = true;
        codeBuf = [];
        codeLang = fence[1]?.trim() ?? '';
        codeStart = i;
      } else {
        blocks.push({ kind: 'code', lines: codeBuf, lang: codeLang, idx: codeStart });
        inCode = false;
        codeBuf = [];
        codeLang = '';
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(raw);
    } else {
      blocks.push({ kind: 'md', line: raw, idx: i });
    }
  }
  // Unterminated fence (model still streaming): render whatever we
  // captured so far as a code block so the partial block isn't
  // invisible until the closing ``` arrives.
  if (inCode && codeBuf.length > 0) {
    blocks.push({ kind: 'code', lines: codeBuf, lang: codeLang, idx: codeStart });
  }
  return (
    <box
      key={keyPrefix}
      style={{
        flexDirection: 'column',
        backgroundColor: palette.backgroundPanel,
        width: '100%'
      }}
    >
      {blocks.map((b) => {
        const k = `${keyPrefix}_b${b.idx}`;
        if (b.kind === 'code') {
          return (
            <box
              key={k}
              style={{
                flexDirection: 'column',
                backgroundColor: palette.backgroundElement,
                paddingLeft: 2,
                paddingRight: 2,
                paddingTop: 0,
                paddingBottom: 0,
                marginTop: 0,
                marginBottom: 0,
                width: '100%'
              }}
            >
              {b.lang ? (
                <box
                  style={{
                    flexDirection: 'row',
                    backgroundColor: palette.backgroundElement
                  }}
                >
                  <text fg={palette.textDim} attributes={ITALIC_ATTR}>{b.lang}</text>
                </box>
              ) : null}
              {b.lines.map((cl, j) => (
                <box
                  key={`${k}_c${j}`}
                  style={{
                    flexDirection: 'row',
                    backgroundColor: palette.backgroundElement
                  }}
                >
                  <text fg={palette.warning}>{cl.length === 0 ? ' ' : cl}</text>
                </box>
              ))}
            </box>
          );
        }
        const raw = b.line;
        if (/^#{1,6}\s/.test(raw)) {
          const stripped = raw.replace(/^#{1,6}\s+/, '');
          return (
            <box
              key={k}
              style={{
                flexDirection: 'row',
                backgroundColor: palette.backgroundPanel
              }}
            >
              <text fg={palette.accent} attributes={HEADING_ATTR}>{stripped}</text>
            </box>
          );
        }
        return renderInlineMarkdown(raw, defaultColor, k);
      })}
    </box>
  );
};
