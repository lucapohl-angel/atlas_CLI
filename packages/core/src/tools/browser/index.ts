/**
 * Built-in tool: `browser` — drive a headless Chromium via Playwright.
 *
 * One tool with an `op` discriminator:
 *
 *   navigate  open a URL (SSRF-pre-flighted)
 *   snapshot  return the accessibility tree with [ref=eN] markers
 *   click     click element by ref
 *   type      focus + set value (optionally press Enter)
 *   press     send a keypress (e.g. "Enter", "Tab", "ArrowDown")
 *   scroll    wheel scroll up/down/left/right
 *   back      navigate back in history
 *   console   read console + pageerror buffer (and optionally eval JS)
 *
 * Refs are valid only until the next `snapshot` call.
 *
 * Playwright is an optional dependency; if it's not installed the tool
 * fails with a one-line install hint instead of crashing the process.
 */
import { z } from 'zod';
import { atlasError } from '../../errors.js';
import { err, ok } from '../../result.js';
import type { Tool } from '../types.js';
import {
  browserBack,
  browserClick,
  browserConsole,
  browserNavigate,
  browserPress,
  browserScroll,
  browserSnapshot,
  browserType,
  closeBrowser
} from './session.js';

const Input = z.discriminatedUnion('op', [
  z.object({ op: z.literal('navigate'), url: z.string().url() }),
  z.object({
    op: z.literal('snapshot'),
    interactiveOnly: z.boolean().default(true),
    maxLines: z.number().int().min(1).max(2000).default(400)
  }),
  z.object({ op: z.literal('click'), ref: z.string().min(1).max(20) }),
  z.object({
    op: z.literal('type'),
    ref: z.string().min(1).max(20),
    text: z.string().max(8000),
    submit: z.boolean().default(false)
  }),
  z.object({ op: z.literal('press'), key: z.string().min(1).max(40) }),
  z.object({
    op: z.literal('scroll'),
    direction: z.enum(['up', 'down', 'left', 'right']),
    amount: z.number().int().min(1).max(20000).default(600)
  }),
  z.object({ op: z.literal('back') }),
  z.object({
    op: z.literal('console'),
    clear: z.boolean().default(false),
    expression: z.string().max(2000).optional()
  }),
  z.object({ op: z.literal('close') })
]);

export const browserTool: Tool<z.infer<typeof Input>> = {
  name: 'browser',
  description:
    'Drive a headless Chromium browser. One persistent tab per Atlas process.',
  approval: 'auto',
  schema: Input,
  whenToUse:
    'Use when a task needs JS-rendered pages, login flows, or interactive elements that `web_fetch` cannot reach. Always `navigate` first, then call `snapshot` to obtain refs, then `click` / `type` / `press` / `scroll`. Refs reset on every `snapshot`. Prefer `web_fetch` for static documentation.',
  outputContract:
    '`navigate` / `back`: summary `GET <finalUrl>` + page title. `snapshot`: a YAML-ish accessibility tree where interactive elements are tagged `[ref=e1]`. `click` / `type` / `press` / `scroll`: short ack. `console`: recent console entries (and the eval result if `expression` was provided). On failure the message points at the next action (re-snapshot, install, navigate first).',
  blockedOps: [
    'navigation to private/loopback/CGNAT/metadata addresses (SSRF)',
    'arbitrary JS evaluation outside `console.expression` (kept short to discourage logic-in-the-browser)',
    'multiple tabs / popups (single page per process)'
  ],
  examples: [
    {
      input: '{"op":"navigate","url":"https://example.com"}',
      result: 'loads the page, returns finalUrl + title'
    },
    {
      input: '{"op":"snapshot"}',
      result: 'returns an indented accessibility tree with [ref=eN] markers',
      note: 'always call snapshot before click/type — refs are per-snapshot'
    },
    {
      input: '{"op":"type","ref":"e3","text":"hello","submit":true}',
      result: 'fills the textbox at ref e3 and presses Enter'
    }
  ],
  async execute(input, ctx) {
    if (ctx.signal?.aborted) return err(atlasError('TOOL_CANCELLED', 'browser cancelled'));

    switch (input.op) {
      case 'navigate': {
        const r = await browserNavigate(input.url, ctx.signal);
        if (!r.ok) return r;
        return ok({
          type: 'ok',
          summary: `navigated -> ${r.value.url}\ntitle: ${r.value.title}`,
          data: r.value
        });
      }
      case 'snapshot': {
        const r = await browserSnapshot({
          interactiveOnly: input.interactiveOnly,
          maxLines: input.maxLines
        });
        if (!r.ok) return r;
        return ok({
          type: 'ok',
          summary: `snapshot @ ${r.value.url} (${r.value.refs} interactive refs)\ntitle: ${r.value.title}\n\n${r.value.tree}`,
          data: r.value
        });
      }
      case 'click': {
        const r = await browserClick(input.ref);
        if (!r.ok) return r;
        return ok({ type: 'ok', summary: `clicked ${input.ref}` });
      }
      case 'type': {
        const r = await browserType(input.ref, input.text, input.submit);
        if (!r.ok) return r;
        return ok({
          type: 'ok',
          summary: `typed into ${input.ref}${input.submit ? ' + submitted' : ''}`
        });
      }
      case 'press': {
        const r = await browserPress(input.key);
        if (!r.ok) return r;
        return ok({ type: 'ok', summary: `pressed ${input.key}` });
      }
      case 'scroll': {
        const r = await browserScroll(input.direction, input.amount);
        if (!r.ok) return r;
        return ok({ type: 'ok', summary: `scrolled ${input.direction} ${input.amount}px` });
      }
      case 'back': {
        const r = await browserBack();
        if (!r.ok) return r;
        if (!r.value) return ok({ type: 'ok', summary: 'no history to go back to' });
        return ok({
          type: 'ok',
          summary: `navigated back -> ${r.value.url}\ntitle: ${r.value.title}`,
          data: r.value
        });
      }
      case 'console': {
        const consoleOpts: { clear?: boolean; expression?: string } = {};
        if (input.clear !== undefined) consoleOpts.clear = input.clear;
        if (input.expression !== undefined) consoleOpts.expression = input.expression;
        const r = await browserConsole(consoleOpts);
        if (!r.ok) return r;
        const lines = r.value.entries.map((e) => `[${e.level}] ${e.text}`).join('\n');
        const head = r.value.result !== undefined ? `=> ${r.value.result}\n` : '';
        return ok({
          type: 'ok',
          summary: `${head}${lines || '(no console entries)'}`,
          data: r.value
        });
      }
      case 'close': {
        await closeBrowser();
        return ok({ type: 'ok', summary: 'browser closed' });
      }
    }
  }
};
