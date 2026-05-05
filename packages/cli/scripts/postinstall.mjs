#!/usr/bin/env node
/**
 * atlas-os postinstall — best-effort browser bootstrap.
 *
 * After `npm i -g atlas-os`, ensure Playwright's Chromium is on disk
 * so the built-in `browser` tool works out of the box on the JS
 * fallback path. We never fail the install: missing playwright,
 * sandboxed npm, offline networks, or a CI environment all degrade
 * to a one-line hint rather than blocking the install.
 *
 * Skipped automatically when:
 *   - `ATLAS_SKIP_BROWSER_INSTALL=1` is set,
 *   - the install is happening inside our own monorepo (workspace
 *     installs would re-trigger this every `pnpm install`),
 *   - Playwright already reports Chromium is present.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

if (process.env.ATLAS_SKIP_BROWSER_INSTALL === '1') process.exit(0);

// Inside the monorepo dev tree, package.json sits at packages/cli/, so
// look for the workspace root marker. Skip the heavy install there.
if (existsSync(join(here, '..', '..', '..', 'pnpm-workspace.yaml'))) {
  process.exit(0);
}

const require = createRequire(import.meta.url);
let cliJs;
try {
  cliJs = require.resolve('playwright/cli.js');
} catch {
  // Playwright is an optional dep — if npm refused to install it
  // (unsupported platform, --no-optional, etc.), we silently skip.
  process.exit(0);
}

const child = spawn(process.execPath, [cliJs, 'install', 'chromium'], {
  stdio: 'ignore',
  env: process.env
});
child.on('error', () => process.exit(0));
child.on('exit', () => process.exit(0));

// Hard cap: don't hold up the npm install for more than 5 minutes.
setTimeout(() => {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  process.exit(0);
}, 5 * 60 * 1000).unref();
