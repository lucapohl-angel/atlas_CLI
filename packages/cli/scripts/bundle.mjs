// Bundles atlas-os CLI into a single self-contained ESM file per entry,
// inlining @atlas/core (workspace) while keeping heavy runtime deps
// (react, OpenTUI, pino, etc.) as external require()s resolved by npm.
//
// Output: packages/cli/dist/launcher.mjs (npm `bin`, no deps, dispatches
//                                          to native binary or JS fallback)
//         packages/cli/dist/bin/atlas.js (JS fallback, with shebang)
//         packages/cli/dist/index.js     (library entry, optional)

import { build } from 'esbuild';
import { chmod, copyFile, writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const corePkg = JSON.parse(
  await readFile(resolve(root, '../core/package.json'), 'utf8'),
);

// Anything declared as a runtime dep stays external; everything else
// (incl. @atlas/core via workspace) gets bundled inline.
//
// Exception: a small allow-list of deps gets bundled inline EVEN
// THOUGH they're declared as runtime deps. These are packages whose
// re-export shape (`export { x } from '…'`) confuses Bun's
// `bun build --compile` resolver, producing runtime
// `ReferenceError: <name> is not defined` once the binary boots.
// esbuild handles those re-exports correctly, so by inlining them
// here we hand Bun an opaque pre-resolved blob instead of letting
// it walk the import graph.
const FORCE_INLINE = new Set([
  '@opentui/react',
  'es-toolkit',
  'es-toolkit/compat',
  // React is pulled in by @opentui/react. Once we inline the binding
  // we inline React too so Bun doesn't try to resolve it from the
  // embedded fs root at runtime.
  'react',
  'react-reconciler',
]);
const externals = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
].filter((d) => !FORCE_INLINE.has(d));

// Replace @atlas/core's version.ts (which uses createRequire to read
// package.json at runtime — fine in dev, broken when bundled) with a
// virtual module that hard-codes the values at bundle time.
const versionInjector = {
  name: 'atlas-version-inject',
  setup(b) {
    const filter = /[\\/]packages[\\/]core[\\/]dist[\\/]version\.js$/;
    b.onLoad({ filter }, () => ({
      contents: [
        `export const ATLAS_VERSION = ${JSON.stringify(pkg.version)};`,
        `export const ATLAS_PACKAGE_NAME = ${JSON.stringify('atlas-os')};`,
      ].join('\n'),
      loader: 'js',
    }));
  },
};

const common = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  external: externals,
  banner: {
    js: [
      'import { createRequire as __atlasCreateRequire } from "node:module";',
      'const require = __atlasCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  plugins: [versionInjector],
  logLevel: 'info',
  legalComments: 'none',
  minify: false,
  sourcemap: false,
};

await mkdir(resolve(root, 'dist/bin'), { recursive: true });

// 1. CLI bin entry — source already starts with `#!/usr/bin/env node`.
//    esbuild preserves that comment in the bundle output.
await build({
  ...common,
  entryPoints: [resolve(root, 'src/bin/atlas.ts')],
  outdir: resolve(root, 'dist/bin'),
  entryNames: 'atlas',
});
await chmod(resolve(root, 'dist/bin/atlas.js'), 0o755);

// 2. Library entry (kept for parity with package.json `main`).
const indexEntry = resolve(root, 'src/index.ts');
if (existsSync(indexEntry)) {
  await build({
    ...common,
    entryPoints: [indexEntry],
    outdir: resolve(root, 'dist'),
    entryNames: 'index',
  });
}

// 3. Empty types file so package.json `types` field still resolves.
//    Real declaration emit lives behind tsc; we don't ship .d.ts for the
//    bundled CLI surface (users invoke the binary, not import it).
await writeFile(
  resolve(root, 'dist/index.d.ts'),
  'export {};\n',
  'utf8',
);

// 4. Launcher (no bundling — pure Node script with zero deps).
//    This is what package.json `bin` points to. It tries the native
//    Bun-compiled binary first, falls back to dist/bin/atlas.js.
await copyFile(
  resolve(root, 'src/launcher.mjs'),
  resolve(root, 'dist/launcher.mjs'),
);
await chmod(resolve(root, 'dist/launcher.mjs'), 0o755);

console.log('atlas-os bundle complete →', resolve(root, 'dist'));
