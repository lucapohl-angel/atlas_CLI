#!/usr/bin/env bun
/**
 * Cross-compile the atlas-os JS bundle into self-contained executables
 * with `bun build --compile`, one per supported platform/arch, then drop
 * each binary into the matching `packages/binaries/<platform-arch>/bin/`
 * directory so it can be published as part of that platform package.
 *
 * Run from repo root:
 *
 *   bun run scripts/build-binaries.mjs                # all targets
 *   bun run scripts/build-binaries.mjs linux-x64      # one target
 *
 * Requires Bun. Produces one self-contained binary per target that
 * embeds the Bun runtime, so end users do NOT need Bun (or Node)
 * installed to run the produced executable.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const cliDir = resolve(repoRoot, 'packages/cli');
const binariesDir = resolve(repoRoot, 'packages/binaries');

// (platform-arch) -> bun --target= triple. Order matters only for logs.
const TARGETS = {
  'linux-x64': 'bun-linux-x64',
  'linux-arm64': 'bun-linux-arm64',
  'darwin-x64': 'bun-darwin-x64',
  'darwin-arm64': 'bun-darwin-arm64',
  'win32-x64': 'bun-windows-x64',
};

// Optional / dev-only modules that we want Bun to resolve to an empty
// stub instead of either bundling them (huge / impossible) or failing
// `import.meta.resolve()` checks at runtime.
//
// All of these are guarded behind a try/catch or an env-var check in
// their importers (Ink devtools, Playwright bidi/electron). Returning
// an empty module from the resolve plugin is safe — the importer's
// guard treats "module exists but is empty" the same as "module loaded
// successfully" and the actual usage paths are never executed.
const STUB_MODULES = new Set([
  'electron',
  'react-devtools-core',
  'playwright',
  'playwright-core',
  'chromium-bidi',
  'chromium-bidi/lib/cjs/bidiMapper/BidiMapper',
  'chromium-bidi/lib/cjs/cdp/CdpConnection',
]);

const stubPlugin = {
  name: 'atlas-stub-optional-modules',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (STUB_MODULES.has(args.path)) {
        return { path: `atlas-stub:${args.path}`, namespace: 'atlas-stub' };
      }
      return undefined;
    });
    build.onLoad({ filter: /.*/, namespace: 'atlas-stub' }, () => ({
      contents: 'export default {}; export const initialize = () => {}; export const connectToDevTools = () => {};',
      loader: 'js',
    }));
  },
};

function ensureBundle() {
  const bundle = resolve(cliDir, 'dist/bin/atlas.js');
  if (!existsSync(bundle)) {
    console.log('• building JS bundle (pnpm --filter atlas-os build)');
    const r = spawnSync('pnpm', ['--filter', 'atlas-os', 'build'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    if (r.status !== 0) throw new Error('JS bundle build failed');
  } else {
    console.log('• reusing existing JS bundle:', bundle);
  }
  return bundle;
}

async function compileFor(slug) {
  const target = TARGETS[slug];
  if (!target) {
    throw new Error(`Unknown target: ${slug}. Known: ${Object.keys(TARGETS).join(', ')}`);
  }
  const bundle = ensureBundle();
  const outDir = resolve(binariesDir, slug, 'bin');
  mkdirSync(outDir, { recursive: true });
  const isWin = slug.startsWith('win32');
  const outFile = join(outDir, isWin ? 'atlas.exe' : 'atlas');

  console.log(`\n→ compiling ${slug} (${target}) → ${outFile}`);
  const result = await Bun.build({
    entrypoints: [bundle],
    // Keep minification off: Bun's minifier renames imported bindings
    // (e.g. `throttle` from es-toolkit/compat → `US`) in a way that
    // breaks the link to the original export, producing runtime
    // ReferenceErrors like "US is not defined" inside Ink. The size
    // cost is negligible compared to the embedded Bun runtime.
    minify: false,
    sourcemap: 'linked',
    plugins: [stubPlugin],
    compile: {
      target,
      outfile: outFile,
    },
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`compile ${slug} failed`);
  }
  if (existsSync(outFile)) {
    const size = (statSync(outFile).size / (1024 * 1024)).toFixed(1);
    console.log(`  ✓ ${slug}: ${size} MB`);
  } else {
    throw new Error(`compile ${slug} produced no file at ${outFile}`);
  }
}

const requested = process.argv.slice(2);
const slugs = requested.length > 0 ? requested : Object.keys(TARGETS);
for (const slug of slugs) {
  await compileFor(slug);
}
console.log('\nDone.');
// Suppress an unused-import warning when building with strict tools.
void writeFileSync;
