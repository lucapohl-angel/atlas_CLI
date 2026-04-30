/**
 * Tiny cross-platform PATH lookup. Returns the absolute path to `bin`
 * if it exists and is executable, or `null` otherwise. We don't shell
 * out to `which`/`where` so we get consistent behavior on every OS and
 * don't pay the spawn cost.
 */
import { access, constants } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export const findOnPath = async (bin: string): Promise<string | null> => {
  if (!bin) return null;
  const PATH = process.env['PATH'] ?? '';
  const isWin = platform() === 'win32';
  const sep = isWin ? ';' : ':';
  const exts = isWin
    ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  // XDG-standard "user-local bins" — atlas's own auto-installers (e.g.
  // the github-mcp-server tarball installer) drop binaries here. Many
  // distros + Homebrew already prepend it to PATH, but we probe it
  // unconditionally so a fresh shell that hasn't sourced it yet still
  // resolves the binary.
  const extraDirs = isWin ? [] : [join(homedir(), '.local', 'bin')];
  const allDirs = [...PATH.split(sep).filter(Boolean), ...extraDirs];
  for (const dir of allDirs) {
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
