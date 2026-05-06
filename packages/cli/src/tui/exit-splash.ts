const WORDMARK_LINES = [
  '  █████╗ ████████╗██╗      █████╗ ███████╗    ██████╗ ███████╗',
  ' ██╔══██╗╚══██╔══╝██║     ██╔══██╗██╔════╝   ██╔═══██╗██╔════╝',
  ' ███████║   ██║   ██║     ███████║███████╗   ██║   ██║███████╗',
  ' ██╔══██║   ██║   ██║     ██╔══██║╚════██║   ██║   ██║╚════██║',
  ' ██║  ██║   ██║   ███████╗██║  ██║███████║   ╚██████╔╝███████║',
  ' ╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚══════╝    ╚═════╝ ╚══════╝'
] as const;

const ANSI_RESET = '\x1b[0m';
const ANSI_DIM = '\x1b[2m';
const TERMINAL_RESTORE_SEQUENCE = [
  '\x1b[0m',
  '\x1b[?25h',
  '\x1b[?2004l',
  '\x1b[?1000l',
  '\x1b[?1002l',
  '\x1b[?1003l',
  '\x1b[?1004l',
  '\x1b[?1005l',
  '\x1b[?1006l',
  '\x1b[?1015l'
].join('');
const ANSI_COLORS = [
  '\x1b[38;2;96;165;250m',
  '\x1b[38;2;96;165;250m',
  '\x1b[38;2;59;130;246m',
  '\x1b[38;2;59;130;246m',
  '\x1b[38;2;14;165;233m',
  '\x1b[38;2;14;165;233m'
] as const;

export const renderAtlasExitSplash = (color: boolean): string => {
  const wordmark = WORDMARK_LINES.map((line, index) => {
    if (!color) return line;
    return `${ANSI_COLORS[index] ?? ANSI_COLORS[0]}${line}${ANSI_RESET}`;
  }).join('\n');
  const caption = 'ATLAS OS';
  const tagline = 'Autonomous Teams · Lifecycle · Agents · Skills';
  if (!color) return `\n${wordmark}\n${caption}\n${tagline}\n`;
  return `\n${wordmark}\n\x1b[1m${caption}${ANSI_RESET}\n${ANSI_DIM}${tagline}${ANSI_RESET}\n`;
};

export const printAtlasExitSplash = (
  stdout: Pick<NodeJS.WriteStream, 'write' | 'isTTY'> = process.stdout
): void => {
  if (process.env['ATLAS_NO_EXIT_SPLASH']) return;
  const color = stdout.isTTY === true && !process.env['NO_COLOR'];
  stdout.write(renderAtlasExitSplash(color));
};

export const restoreInteractiveTerminal = ({
  stdin = process.stdin,
  stdout = process.stdout
}: {
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: Pick<NodeJS.WriteStream, 'write' | 'isTTY'>;
} = {}): void => {
  if (stdout.isTTY === true) {
    stdout.write(TERMINAL_RESTORE_SEQUENCE);
  }
  if (stdin.isTTY === true && typeof stdin.setRawMode === 'function') {
    try {
      stdin.setRawMode(false);
    } catch {
      /* noop */
    }
  }
  stdin.pause();
};