/**
 * Structured logger built on Pino. All Atlas modules log through this.
 *
 * Default level is 'info'. Set ATLAS_LOG_LEVEL=debug for verbose output.
 * Logs go to stderr so they never collide with the agent's stdout output
 * (TUI rendering, JSON tool results, etc.).
 */
import pino, { type Logger } from 'pino';

const LEVEL = process.env['ATLAS_LOG_LEVEL'] ?? 'info';
// In interactive TUI mode pino's stderr writes corrupt the Ink alt-screen
// layout (pushing the header off the top, bumping errors below the input).
// Set ATLAS_TUI=1 to silence the logger; fatal errors are still surfaced
// to the user via the transcript.
const SILENT = process.env['ATLAS_TUI'] === '1';
const PRETTY = !SILENT && process.stderr.isTTY && process.env['ATLAS_LOG_JSON'] !== '1';

export const logger: Logger = pino(
  {
    level: SILENT ? 'silent' : LEVEL,
    base: { name: 'atlas' },
    timestamp: pino.stdTimeFunctions.isoTime
  },
  PRETTY
    ? pino.transport({
        target: 'pino-pretty',
        options: {
          destination: 2, // stderr
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname,name',
          singleLine: false
        }
      })
    : pino.destination(2)
);

/**
 * Create a child logger with a fixed component label.
 * Use one per major module so log lines are easy to filter.
 */
export const childLogger = (
  component: string,
  bindings: Record<string, unknown> = {}
): Logger => logger.child({ component, ...bindings });
