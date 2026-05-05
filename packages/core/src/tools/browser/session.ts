/**
 * Per-process headless Chromium session for the `browser` tool.
 *
 * Design goals (lifted from Hermes' browser_tool, adapted for Node):
 *   - One Chromium instance per Atlas process — re-used across calls.
 *   - Single page (single tab). New navigations replace the current page.
 *   - Snapshots return an accessibility tree with `[ref=e1]`-style refs
 *     so the model can address elements without leaking selectors.
 *   - Refs are resolved via a per-snapshot map of strong handles which
 *     are released on the next snapshot.
 *   - Playwright is an *optional* dependency — we dynamic-import so a
 *     missing install fails loudly but doesn't crash the rest of Atlas.
 *
 * SSRF: every `goto()` is pre-flighted through `checkUrlSafety` to keep
 * the browser from being used as a metadata-service or LAN scanner.
 */
import { childLogger } from '../../logger.js';
import { atlasError } from '../../errors.js';
import type { Result } from '../../result.js';
import { ok, err } from '../../result.js';
import { checkUrlSafety } from '../../security/url-safety.js';

type Browser = {
  close(): Promise<void>;
  newContext(opts?: unknown): Promise<BrowserContext>;
};
type BrowserContext = {
  newPage(): Promise<Page>;
  close(): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on?(event: string, handler: (...args: any[]) => void): void;
};
type Page = {
  goto(url: string, opts?: unknown): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  goBack(opts?: unknown): Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evaluate<T>(fn: (...a: any[]) => T, arg?: unknown): Promise<T>;
  keyboard: { press(k: string): Promise<void> };
  mouse: { wheel(dx: number, dy: number): Promise<void> };
  accessibility: { snapshot(opts?: unknown): Promise<AxNode | null> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (...args: any[]) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeAllListeners?(event?: string): void;
};

export interface AxNode {
  readonly role?: string;
  readonly name?: string;
  readonly value?: string | number;
  readonly description?: string;
  readonly checked?: boolean | 'mixed';
  readonly disabled?: boolean;
  readonly expanded?: boolean;
  readonly focused?: boolean;
  readonly selected?: boolean;
  readonly children?: readonly AxNode[];
}

const log = childLogger('browser');

let _browserPromise: Promise<Browser> | null = null;
let _ctx: BrowserContext | null = null;
let _page: Page | null = null;
let _consoleLog: { level: string; text: string; ts: number }[] = [];
let _refMap = new Map<string, AxNode>();
let _refCounter = 0;

const CONSOLE_BUFFER_MAX = 500;
const NAV_TIMEOUT_MS = 30_000;

const loadPlaywright = async (): Promise<{ chromium: { launch: (o: unknown) => Promise<Browser> } } | null> => {
  try {
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    const mod = (await import('playwright')) as unknown as {
      chromium?: { launch?: (o: unknown) => Promise<Browser> };
      default?: { chromium?: { launch?: (o: unknown) => Promise<Browser> } };
    };
    // When this file is bundled by `bun build --compile` and the
    // host process doesn't actually have `playwright` resolvable,
    // the dynamic import can succeed with an empty module shim that
    // lacks `chromium` — in which case calling `.chromium.launch`
    // throws the cryptic `undefined is not an object (evaluating
    // 'A.chromium.launch')`. Guard explicitly.
    const chromium = mod.chromium ?? mod.default?.chromium;
    if (!chromium || typeof chromium.launch !== 'function') return null;
    return { chromium: chromium as { launch: (o: unknown) => Promise<Browser> } };
  } catch {
    return null;
  }
};

export const browserAvailable = async (): Promise<boolean> => {
  return (await loadPlaywright()) !== null;
};

const isCompiledBunBinary = (): boolean => {
  // bun build --compile produces a single-file executable whose
  // process.execPath is the binary itself (not `bun` / `node`). Use
  // that, plus the presence of the Bun global, as a heuristic.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (globalThis as any).Bun === 'undefined') return false;
  const exe = (process.execPath ?? '').toLowerCase();
  return !/(?:^|[\\/])(?:node|bun)(?:\.exe)?$/.test(exe);
};

const ensureBrowser = async (): Promise<Result<Page, ReturnType<typeof atlasError>>> => {
  if (_page) return ok(_page);

  const pw = await loadPlaywright();
  if (!pw) {
    const msg = isCompiledBunBinary()
      ? 'browser tool is not available in the precompiled atlas binary (Playwright cannot be embedded cross-platform). Reinstall via `npm i -g atlas-os` to enable it — Chromium will be downloaded automatically on install.'
      : 'browser tool requires Playwright + Chromium. Run `atlas` /setup → install browser, or `npx playwright install chromium`.';
    return err(atlasError('TOOL_EXECUTION_FAILED', msg));
  }

  if (!_browserPromise) {
    _browserPromise = pw.chromium.launch({ headless: true });
  }
  let browser: Browser;
  try {
    browser = await _browserPromise;
  } catch (e) {
    _browserPromise = null;
    return err(
      atlasError(
        'TOOL_EXECUTION_FAILED',
        `failed to launch chromium: ${(e as Error).message}. Try \`pnpm exec playwright install chromium\`.`
      )
    );
  }

  try {
    _ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Atlas/0.1 Chrome/120.0.0.0 Safari/537.36'
    });
  } catch (e) {
    return err(atlasError('TOOL_EXECUTION_FAILED', `newContext failed: ${(e as Error).message}`));
  }

  try {
    _page = await _ctx.newPage();
  } catch (e) {
    return err(atlasError('TOOL_EXECUTION_FAILED', `newPage failed: ${(e as Error).message}`));
  }

  // Capture console messages so the agent can inspect JS errors later.
  _page.on('console', (msg: { type(): string; text(): string }) => {
    _consoleLog.push({ level: msg.type(), text: msg.text(), ts: Date.now() });
    if (_consoleLog.length > CONSOLE_BUFFER_MAX) _consoleLog.shift();
  });
  _page.on('pageerror', (e: Error) => {
    _consoleLog.push({ level: 'pageerror', text: e.message, ts: Date.now() });
    if (_consoleLog.length > CONSOLE_BUFFER_MAX) _consoleLog.shift();
  });

  return ok(_page);
};

export const closeBrowser = async (): Promise<void> => {
  try {
    if (_page) await (_page as unknown as { close?: () => Promise<void> }).close?.();
  } catch {
    /* ignore */
  }
  try {
    if (_ctx) await _ctx.close();
  } catch {
    /* ignore */
  }
  try {
    if (_browserPromise) {
      const b = await _browserPromise;
      await b.close();
    }
  } catch {
    /* ignore */
  }
  _page = null;
  _ctx = null;
  _browserPromise = null;
  _consoleLog = [];
  _refMap.clear();
  _refCounter = 0;
};

// ---- Navigation ---------------------------------------------------------

export const browserNavigate = async (
  url: string,
  signal?: AbortSignal
): Promise<Result<{ url: string; title: string }, ReturnType<typeof atlasError>>> => {
  const safety = await checkUrlSafety(url);
  if (!safety.ok) return err(safety.error);

  const pageR = await ensureBrowser();
  if (!pageR.ok) return pageR;
  const page = pageR.value;

  if (signal?.aborted) return err(atlasError('CANCELLED', 'cancelled before navigation'));
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  } catch (e) {
    return err(atlasError('TOOL_EXECUTION_FAILED', `navigation failed: ${(e as Error).message}`));
  }
  return ok({ url: page.url(), title: await page.title() });
};

export const browserBack = async (): Promise<
  Result<{ url: string; title: string } | null, ReturnType<typeof atlasError>>
> => {
  const pageR = await ensureBrowser();
  if (!pageR.ok) return pageR;
  const page = pageR.value;
  try {
    const r = await page.goBack({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    if (!r) return ok(null);
  } catch (e) {
    return err(atlasError('TOOL_EXECUTION_FAILED', `back failed: ${(e as Error).message}`));
  }
  return ok({ url: page.url(), title: await page.title() });
};

// ---- Snapshot (accessibility tree) -------------------------------------

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'menuitem',
  'option',
  'tab',
  'slider',
  'spinbutton'
]);

const escapeName = (s: string | undefined): string => {
  if (!s) return '';
  const trimmed = s.trim().replace(/\s+/g, ' ');
  if (trimmed.length > 80) return JSON.stringify(trimmed.slice(0, 80) + '…');
  return JSON.stringify(trimmed);
};

interface FormatOpts {
  readonly maxLines: number;
}

const formatNode = (node: AxNode, depth: number, lines: string[], opts: FormatOpts): void => {
  if (lines.length >= opts.maxLines) return;
  const role = node.role ?? '';
  if (!role || role === 'none' || role === 'presentation' || role === 'generic') {
    for (const c of node.children ?? []) formatNode(c, depth, lines, opts);
    return;
  }
  const isInteractive = INTERACTIVE_ROLES.has(role);
  let ref = '';
  if (isInteractive) {
    _refCounter += 1;
    const id = `e${_refCounter}`;
    _refMap.set(id, node);
    ref = ` [ref=${id}]`;
  }
  const indent = '  '.repeat(Math.min(depth, 12));
  const name = escapeName(node.name);
  const state: string[] = [];
  if (node.checked === true) state.push('checked');
  if (node.checked === 'mixed') state.push('mixed');
  if (node.selected) state.push('selected');
  if (node.disabled) state.push('disabled');
  if (node.focused) state.push('focused');
  if (node.expanded === true) state.push('expanded');
  const stateStr = state.length > 0 ? ` (${state.join(',')})` : '';
  const valStr =
    node.value !== undefined && node.value !== '' ? ` value=${JSON.stringify(String(node.value))}` : '';
  lines.push(`${indent}- ${role}${name ? ' ' + name : ''}${valStr}${stateStr}${ref}`);

  for (const c of node.children ?? []) formatNode(c, depth + 1, lines, opts);
};

export const browserSnapshot = async (
  opts: { interactiveOnly?: boolean; maxLines?: number } = {}
): Promise<
  Result<{ url: string; title: string; tree: string; refs: number }, ReturnType<typeof atlasError>>
> => {
  const pageR = await ensureBrowser();
  if (!pageR.ok) return pageR;
  const page = pageR.value;

  let snap: AxNode | null;
  try {
    snap = await page.accessibility.snapshot({ interestingOnly: opts.interactiveOnly !== false });
  } catch (e) {
    return err(
      atlasError('TOOL_EXECUTION_FAILED', `snapshot failed: ${(e as Error).message}`)
    );
  }
  _refMap.clear();
  _refCounter = 0;
  const lines: string[] = [];
  if (snap) formatNode(snap, 0, lines, { maxLines: opts.maxLines ?? 400 });

  return ok({
    url: page.url(),
    title: await page.title(),
    tree: lines.length > 0 ? lines.join('\n') : '(empty page)',
    refs: _refMap.size
  });
};

// ---- Element interactions ----------------------------------------------

const findElementForRef = async (ref: string): Promise<Result<unknown, ReturnType<typeof atlasError>>> => {
  const pageR = await ensureBrowser();
  if (!pageR.ok) return pageR;
  const page = pageR.value;
  const node = _refMap.get(ref);
  if (!node) {
    return err(
      atlasError(
        'TOOL_INPUT_INVALID',
        `unknown ref "${ref}" — call browser_snapshot first to get fresh refs (refs reset every snapshot)`
      )
    );
  }
  // Fall back to role+name selector. We rely on Playwright's role engine.
  const role = node.role ?? '';
  const name = node.name ?? '';
  // Page evaluate functions are typed as `any` because the closure runs
  // inside the browser context — Node TS lib has no DOM globals.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lookupFn: any = ({ r, n }: { r: string; n: string }) => {
    const matches: any[] = [];
    const d: any = (globalThis as any).document;
    const all: any[] = Array.from(d.querySelectorAll('*'));
    const roleOf = (el: any): string => {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a' && el.hasAttribute('href')) return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'input') {
        const t = el.type;
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
        return 'textbox';
      }
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return 'combobox';
      return '';
    };
    const accName = (el: any): string => {
      const aria = el.getAttribute('aria-label');
      if (aria) return aria.trim();
      const labelled = el.getAttribute('aria-labelledby');
      if (labelled) {
        const refEl = d.getElementById(labelled);
        if (refEl) return (refEl.textContent ?? '').trim();
      }
      if (el.labels && el.labels.length > 0) {
        return (el.labels[0]?.textContent ?? '').trim();
      }
      if (el.type === 'submit' || el.type === 'button') {
        return el.value || '';
      }
      return (el.textContent ?? '').trim().replace(/\s+/g, ' ');
    };
    for (const el of all) {
      if (roleOf(el) !== r) continue;
      const elName = accName(el);
      if (n && elName && (elName === n || elName.startsWith(n) || n.startsWith(elName))) {
        matches.push(el);
        break;
      }
      if (!n && matches.length === 0) matches.push(el);
    }
    const hit = matches[0];
    if (!hit) return null;
    const id = '__atlas_ref_' + Math.random().toString(36).slice(2);
    hit.setAttribute('data-atlas-ref', id);
    return id;
  };
  try {
    const handle = await page.evaluate(lookupFn, { r: role, n: name });
    if (!handle) {
      return err(
        atlasError(
          'TOOL_EXECUTION_FAILED',
          `could not locate element for ref ${ref} (${role} "${name}") — page may have changed; re-snapshot`
        )
      );
    }
    return ok(handle);
  } catch (e) {
    return err(atlasError('TOOL_EXECUTION_FAILED', `ref lookup failed: ${(e as Error).message}`));
  }
};

const clickByMarker = async (marker: string): Promise<Result<void, ReturnType<typeof atlasError>>> => {
  const pageR = await ensureBrowser();
  if (!pageR.ok) return pageR;
  const page = pageR.value;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn: any = (m: string) => {
      const d: any = (globalThis as any).document;
      const el: any = d.querySelector(`[data-atlas-ref="${m}"]`);
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      el.removeAttribute('data-atlas-ref');
      return true;
    };
    const r = await page.evaluate(fn, marker);
    if (!r) return err(atlasError('TOOL_EXECUTION_FAILED', 'element disappeared before click'));
    return ok(undefined);
  } catch (e) {
    return err(atlasError('TOOL_EXECUTION_FAILED', `click failed: ${(e as Error).message}`));
  }
};

const focusByMarker = async (marker: string): Promise<Result<void, ReturnType<typeof atlasError>>> => {
  const pageR = await ensureBrowser();
  if (!pageR.ok) return pageR;
  const page = pageR.value;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn: any = (m: string) => {
      const d: any = (globalThis as any).document;
      const el: any = d.querySelector(`[data-atlas-ref="${m}"]`);
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.focus();
      if (typeof el.select === 'function') el.select();
      return true;
    };
    const r = await page.evaluate(fn, marker);
    if (!r) return err(atlasError('TOOL_EXECUTION_FAILED', 'element disappeared before focus'));
    return ok(undefined);
  } catch (e) {
    return err(atlasError('TOOL_EXECUTION_FAILED', `focus failed: ${(e as Error).message}`));
  }
};

export const browserClick = async (ref: string): Promise<Result<void, ReturnType<typeof atlasError>>> => {
  const r = await findElementForRef(ref);
  if (!r.ok) return r;
  return clickByMarker(r.value as string);
};

export const browserType = async (
  ref: string,
  text: string,
  submit = false
): Promise<Result<void, ReturnType<typeof atlasError>>> => {
  const r = await findElementForRef(ref);
  if (!r.ok) return r;
  const fr = await focusByMarker(r.value as string);
  if (!fr.ok) return fr;
  const pageR = await ensureBrowser();
  if (!pageR.ok) return pageR;
  const page = pageR.value;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn: any = (t: string) => {
      const d: any = (globalThis as any).document;
      const el: any = d.activeElement;
      if (!el || !('value' in el)) return;
      el.value = t;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Ev: any = (globalThis as any).Event;
      el.dispatchEvent(new Ev('input', { bubbles: true }));
      el.dispatchEvent(new Ev('change', { bubbles: true }));
    };
    await page.evaluate(fn, text);
    if (submit) await page.keyboard.press('Enter');
    return ok(undefined);
  } catch (e) {
    return err(atlasError('TOOL_EXECUTION_FAILED', `type failed: ${(e as Error).message}`));
  }
};

export const browserPress = async (key: string): Promise<Result<void, ReturnType<typeof atlasError>>> => {
  const pageR = await ensureBrowser();
  if (!pageR.ok) return pageR;
  try {
    await pageR.value.keyboard.press(key);
    return ok(undefined);
  } catch (e) {
    return err(atlasError('TOOL_EXECUTION_FAILED', `press failed: ${(e as Error).message}`));
  }
};

export const browserScroll = async (
  direction: 'up' | 'down' | 'left' | 'right',
  amount = 600
): Promise<Result<void, ReturnType<typeof atlasError>>> => {
  const pageR = await ensureBrowser();
  if (!pageR.ok) return pageR;
  const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
  const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
  try {
    await pageR.value.mouse.wheel(dx, dy);
    return ok(undefined);
  } catch (e) {
    return err(atlasError('TOOL_EXECUTION_FAILED', `scroll failed: ${(e as Error).message}`));
  }
};

// ---- Console -----------------------------------------------------------

export const browserConsole = async (opts: {
  clear?: boolean;
  expression?: string;
}): Promise<Result<{ entries: { level: string; text: string }[]; result?: string }, ReturnType<typeof atlasError>>> => {
  const pageR = await ensureBrowser();
  if (!pageR.ok) return pageR;
  const page = pageR.value;
  let result: string | undefined;
  if (opts.expression) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fn: any = (e: string) => {
        // eslint-disable-next-line no-eval
        return JSON.stringify((0, eval)(e));
      };
      const v = await page.evaluate(fn, opts.expression);
      result = typeof v === 'string' ? v : String(v);
    } catch (e) {
      result = `ERROR: ${(e as Error).message}`;
    }
  }
  const entries = _consoleLog.slice(-50).map((c) => ({ level: c.level, text: c.text }));
  if (opts.clear) _consoleLog = [];
  const out: { entries: { level: string; text: string }[]; result?: string } = { entries };
  if (result !== undefined) out.result = result;
  return ok(out);
};

// Keep linter happy when log is unused in builds.
void log;
