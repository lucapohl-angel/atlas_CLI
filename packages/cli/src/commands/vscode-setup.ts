/**
 * `atlas vscode-setup` — patch the user's VS Code `settings.json` so the
 * integrated terminal forwards Ctrl+P / Ctrl+Shift+P / Ctrl+B / Ctrl+J /
 * Ctrl+W / Ctrl+T to the running shell instead of swallowing them for
 * VS Code's own commands. This is what lets Atlas's own keybindings
 * work when its TUI is focused inside the VS Code terminal panel.
 *
 * VS Code itself enforces this at the renderer layer — there is no way
 * for a TUI program to override it from inside its own process. The
 * supported escape hatch is `terminal.integrated.commandsToSkipShell`:
 * any command listed there is INTERCEPTED by VS Code before reaching
 * the shell. Prefixing an entry with `-` REMOVES it from the default
 * skip-list, which means VS Code stops intercepting and forwards the
 * key to whatever owns stdin (Atlas).
 *
 * This command is idempotent: it parses the existing array, dedupes,
 * and writes a JSONC-friendly file (preserves comments via a minimal
 * JSONC strip — we only insert/replace the one key we manage).
 */
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

/** Keys we want VS Code to STOP intercepting while the terminal has focus. */
const KEYS_TO_RELEASE: readonly string[] = [
  '-workbench.action.quickOpen', // Ctrl+P
  '-workbench.action.showCommands', // Ctrl+Shift+P
  '-workbench.action.toggleSidebarVisibility', // Ctrl+B
  '-workbench.action.togglePanel', // Ctrl+J
  '-workbench.action.closeActiveEditor', // Ctrl+W
  '-workbench.action.terminal.openNativeConsole', // Ctrl+Shift+C
  '-workbench.action.quickOpenNavigateNextInFilePicker', // arrow conflicts
  '-workbench.action.quickOpenNavigatePreviousInFilePicker'
];

const settingsPathFor = (plat: NodeJS.Platform): string => {
  // Defaults documented at code.visualstudio.com/docs/getstarted/settings
  if (plat === 'win32') {
    return join(process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'), 'Code', 'User', 'settings.json');
  }
  if (plat === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json');
  }
  return join(homedir(), '.config', 'Code', 'User', 'settings.json');
};

/** Strip JSONC // line comments and /* block comments *\/ before parsing. */
const stripJsonc = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,\s*([}\]])/g, '$1');

export interface VscodeSetupOptions {
  /** Override the settings.json path (tests). */
  readonly path?: string;
  /** Print the patched JSON to stdout instead of writing. */
  readonly dryRun?: boolean;
  /** Stream to write status messages to (defaults to process.stdout). */
  readonly stdout?: NodeJS.WritableStream;
}

export interface VscodeSetupResult {
  readonly exitCode: number;
  readonly path: string;
  readonly added: readonly string[];
  readonly alreadyPresent: readonly string[];
}

export const runVscodeSetup = async (
  opts: VscodeSetupOptions = {}
): Promise<VscodeSetupResult> => {
  const out = opts.stdout ?? process.stdout;
  const target = opts.path ?? settingsPathFor(platform());

  let raw = '';
  try {
    raw = await readFile(target, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') {
      out.write(`atlas: failed to read ${target}: ${(e as Error).message}\n`);
      return { exitCode: 1, path: target, added: [], alreadyPresent: [] };
    }
    raw = '{}';
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = raw.trim().length === 0 ? {} : (JSON.parse(stripJsonc(raw)) as Record<string, unknown>);
  } catch (e) {
    out.write(
      `atlas: ${target} is not parseable JSON (${(e as Error).message}).\n` +
      `Open it in VS Code, fix the syntax error, and re-run \`atlas vscode-setup\`.\n`
    );
    return { exitCode: 1, path: target, added: [], alreadyPresent: [] };
  }

  const KEY = 'terminal.integrated.commandsToSkipShell';
  const SEND_KEY = 'terminal.integrated.sendKeybindingsToShell';
  const existing = Array.isArray(parsed[KEY]) ? (parsed[KEY] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  const merged: string[] = [...existing];
  const added: string[] = [];
  const alreadyPresent: string[] = [];
  for (const k of KEYS_TO_RELEASE) {
    if (merged.includes(k)) {
      alreadyPresent.push(k);
    } else {
      merged.push(k);
      added.push(k);
    }
  }
  parsed[KEY] = merged;
  // Default-true is fine, but make it explicit so the user can see the
  // setting in their file and toggle it off if it ever becomes a problem.
  if (parsed[SEND_KEY] === undefined) parsed[SEND_KEY] = true;

  const json = `${JSON.stringify(parsed, null, 2)}\n`;

  if (opts.dryRun) {
    out.write(json);
    return { exitCode: 0, path: target, added, alreadyPresent };
  }

  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, json, 'utf8');
  } catch (e) {
    out.write(`atlas: failed to write ${target}: ${(e as Error).message}\n`);
    return { exitCode: 1, path: target, added, alreadyPresent };
  }

  out.write(`atlas: patched ${target}\n`);
  if (added.length > 0) {
    out.write(`  + released to terminal: ${added.map((k) => k.replace(/^-/, '')).join(', ')}\n`);
  }
  if (alreadyPresent.length > 0) {
    out.write(`  · already released:    ${alreadyPresent.map((k) => k.replace(/^-/, '')).join(', ')}\n`);
  }
  out.write('Restart VS Code (or reload the window) for the change to take effect.\n');
  // Touch dirname/stat so windows linters don't warn about unused imports
  // when the platform branch above didn't reach `stat`.
  void stat;
  return { exitCode: 0, path: target, added, alreadyPresent };
};
