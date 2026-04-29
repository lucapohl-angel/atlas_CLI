/**
 * `atlas ask "<prompt>"` — fire one question at the configured model and
 * stream tokens to stdout. SIGINT cancels the in-flight request via the
 * shared AbortController.
 *
 * This is the Phase 1 capability: a single round-trip, no tools, no REPL.
 */
import {
  isAtlasError,
  loadConfig,
  providerFromConfig,
  type Message,
  type Provider
} from '@atlas/core';

export interface AskOptions {
  readonly model?: string;
  readonly system?: string;
  readonly temperature?: number;
}

export interface AskDeps {
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly env?: NodeJS.ProcessEnv;
  /** Inject a Provider directly (bypasses config). Used in tests. */
  readonly provider?: Provider;
  /** Inject an AbortSignal (tests). CLI binds SIGINT in `runAsk`. */
  readonly signal?: AbortSignal;
}

export interface AskResult {
  readonly exitCode: number;
}

export const runAsk = async (
  prompt: string,
  options: AskOptions = {},
  deps: AskDeps = {}
): Promise<AskResult> => {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const env = deps.env ?? process.env;

  if (prompt.trim().length === 0) {
    stderr.write('atlas ask: prompt is empty\n');
    return { exitCode: 2 };
  }

  let provider: Provider;
  let model: string;
  let fallbackModels: readonly string[] = [];

  if (deps.provider) {
    provider = deps.provider;
    model = options.model ?? env['ATLAS_MODEL'] ?? 'anthropic/claude-sonnet-4';
  } else {
    const cfgResult = await loadConfig({ env });
    if (!cfgResult.ok) {
      stderr.write(`atlas: ${cfgResult.error.message}\n`);
      return { exitCode: 1 };
    }
    const provResult = providerFromConfig(cfgResult.value);
    if (!provResult.ok) {
      stderr.write(`atlas: ${provResult.error.message}\n`);
      return { exitCode: 1 };
    }
    provider = provResult.value;
    model = options.model ?? cfgResult.value.defaultModel;
    fallbackModels = cfgResult.value.fallbackModels;
  }

  const messages: Message[] = [];
  if (options.system) messages.push({ role: 'system', content: options.system });
  messages.push({ role: 'user', content: prompt });

  const stream = provider.stream({
    model,
    ...(fallbackModels.length > 0 ? { fallbackModels } : {}),
    messages,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(deps.signal ? { signal: deps.signal } : {})
  });

  let sawAnyDelta = false;
  for await (const event of stream) {
    switch (event.type) {
      case 'delta':
        sawAnyDelta = true;
        stdout.write(event.text);
        break;
      case 'done':
        if (sawAnyDelta) stdout.write('\n');
        return { exitCode: 0 };
      case 'error': {
        if (sawAnyDelta) stdout.write('\n');
        const tag = isAtlasError(event.error) ? event.error.code : 'ERROR';
        stderr.write(`atlas: [${tag}] ${event.error.message}\n`);
        return { exitCode: event.error.code === 'CANCELLED' ? 130 : 1 };
      }
    }
  }

  if (sawAnyDelta) stdout.write('\n');
  return { exitCode: 0 };
};
