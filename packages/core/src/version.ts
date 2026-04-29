/**
 * Atlas version — read once at module load. Source of truth is package.json,
 * but we resolve it via createRequire so the build doesn't need to bundle it.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string; name: string };

export const ATLAS_VERSION: string = pkg.version;
export const ATLAS_PACKAGE_NAME: string = pkg.name;
