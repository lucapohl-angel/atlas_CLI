#!/usr/bin/env node
// atlas-os launcher.
//
// Resolution order:
//   1. atlas-os-${platform}-${arch} optional-dep package (Bun-compiled binary)
//   2. Bundled JS fallback (dist/bin/atlas.js) — pure Node + Ink
//
// We never crash: a missing platform package only means we use the
// fallback. That keeps `npm i -g atlas-os` working on any platform we
// haven't built a binary for yet (or while a platform publish is being
// re-rolled).

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const platform = process.platform;
const arch = process.arch;
const ext = platform === 'win32' ? '.exe' : '';
// Note: 'atlas-os-win32-x64' triggered npm's spam filter, so the
// Windows binary package is published as 'atlas-os-win-x64' instead.
const pkgName = platform === 'win32' ? `atlas-os-win-${arch}` : `atlas-os-${platform}-${arch}`;

function tryResolveBinary() {
  try {
    const pkgJsonPath = require.resolve(`${pkgName}/package.json`);
    const binPath = join(dirname(pkgJsonPath), 'bin', `atlas${ext}`);
    if (existsSync(binPath)) {
      // Best-effort exec bit check on POSIX.
      if (platform !== 'win32') {
        try {
          const mode = statSync(binPath).mode;
          // If not executable, try to chmod (npm sometimes drops bits).
          if ((mode & 0o111) === 0) {
            require('node:fs').chmodSync(binPath, 0o755);
          }
        } catch {
          // ignore — let spawn report the real error
        }
      }
      return binPath;
    }
  } catch {
    // Package not installed for this platform; fall through.
  }
  return null;
}

function runBinary(binPath) {
  const child = spawn(binPath, process.argv.slice(2), {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 1);
    }
  });
  child.on('error', (err) => {
    process.stderr.write(`atlas: failed to launch native binary (${err.message}); falling back to JS bundle.\n`);
    runFallback();
  });
}

function runFallback() {
  // dist/bin/atlas.js sits next to dist/launcher.mjs after build.
  const fallback = join(__dirname, 'bin', 'atlas.js');
  if (!existsSync(fallback)) {
    process.stderr.write(
      `atlas: no native binary for ${platform}-${arch} and no JS fallback found.\n` +
        `Install one of: atlas-os-linux-x64, atlas-os-linux-arm64, atlas-os-darwin-x64, atlas-os-darwin-arm64, atlas-os-win-x64\n`,
    );
    process.exit(1);
  }
  // Re-exec under the same Node so flags / env propagate.
  const child = spawn(process.execPath, [fallback, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 1);
    }
  });
}

const binPath = tryResolveBinary();
if (binPath) {
  runBinary(binPath);
} else {
  runFallback();
}
