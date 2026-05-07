import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const ViewSchema = z.object({
  type: z.string().optional(),
  id: z.string(),
  name: z.string(),
});

const PackageSchema = z.object({
  activationEvents: z.array(z.string()),
  contributes: z.object({
    viewsContainers: z.object({
      secondarySidebar: z.array(z.object({
        id: z.string(),
        title: z.string(),
        icon: z.string(),
      })),
      activitybar: z.array(z.unknown()).optional(),
    }),
    views: z.object({
      atlas: z.array(ViewSchema),
    }),
  }),
});

describe('extension manifest', () => {
  it('contributes the Atlas sidebar as a webview', async () => {
    const packageJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const manifest = PackageSchema.parse(JSON.parse(await readFile(packageJsonPath, 'utf8')));
    const atlasContainer = manifest.contributes.viewsContainers.secondarySidebar.find(
      (container) => container.id === 'atlas',
    );
    const atlasSidebar = manifest.contributes.views.atlas.find((view) => view.id === 'atlas.sidebar');

    expect(atlasContainer?.title).toBe('Atlas');
    expect(manifest.contributes.viewsContainers.activitybar).toBeUndefined();
    expect(atlasSidebar?.type).toBe('webview');
    expect(manifest.activationEvents).toContain('onView:atlas.sidebar');
  });
});