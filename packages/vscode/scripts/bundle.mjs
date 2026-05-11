import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

await mkdir(resolve(root, 'dist'), { recursive: true });

await esbuild({
  entryPoints: [resolve(root, 'src/extension.ts')],
  outfile: resolve(root, 'dist/extension.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  banner: {
    js: "const __atlasImportMetaUrl = require('node:url').pathToFileURL(__filename).href;",
  },
  define: {
    'import.meta.url': '__atlasImportMetaUrl',
  },
  external: ['vscode', 'playwright', 'playwright-core', 'chromium-bidi/*'],
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});

await viteBuild({
  configFile: resolve(root, 'vite.config.ts'),
});

console.log('atlas-os-vscode bundle complete ->', resolve(root, 'dist'));
