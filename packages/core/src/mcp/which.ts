/**
 * Tiny cross-platform PATH lookup. Returns the absolute path to `bin`
 * if it exists and is executable, or `null` otherwise. We don't shell
 * out to `which`/`where` so we get consistent behavior on every OS and
 * don't pay the spawn cost.
 */
import { access, constants } from 'node:fs/promises';
import { platform } from 'node:os';
import { join } from 'node:path';

export const findOnPath = async (bin: string): Promise<string | null> => {
  if (!bin) return null;
  const PATH = process.env['PATH'] ?? '';
  const isWin = platform() === 'win32';
  const sep = isWin ? ';' : ':';
  const exts = isWin
    ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const dir of PATH.split(sep).filter(Boolean)) {
    for (const ext of exts) {
      const p = join(dir, bin + ext);
      try {
        await access(p, constants.X_OK);
        return p;
      } catch {
        // try next
      }
    }
  }
  return null;
};
