/**
 * Built-in guardrail hook bundle.
 *
 * `builtinHookRegistry({ cwd, config })` returns a fresh `HookRegistry`
 * pre-populated with the four default guardrails. Each guardrail can
 * be disabled individually via `config.guardrails.*` flags. Pass
 * `enabled: false` at the top level to register zero hooks.
 */
import type { GuardrailsConfig } from '../../config/types.js';
import { HookRegistry } from '../registry.js';
import { dangerousCommandHook } from './dangerous-command.js';
import {
  contradictionHook,
  multiQuestionHook,
  vaguenessHook
} from './discover-guardrails.js';
import { pathSafetyHook } from './path-safety.js';
import { promptInjectionHook } from './prompt-injection.js';
import { secretRedactorHook } from './secret-redactor.js';

export interface BuiltinHookOptions {
  readonly cwd: string;
  readonly config?: GuardrailsConfig;
}

export const builtinHookRegistry = (opts: BuiltinHookOptions): HookRegistry => {
  const reg = new HookRegistry();
  const cfg = opts.config;
  if (cfg && cfg.enabled === false) return reg;

  if (!cfg || cfg.dangerousCommand !== false) {
    reg.register(dangerousCommandHook(cfg?.extraDeniedCommands ?? []));
  }
  if (!cfg || cfg.pathSafety !== false) {
    reg.register(pathSafetyHook(opts.cwd, cfg?.extraDeniedPaths ?? []));
  }
  if (!cfg || cfg.secretRedaction !== false) {
    reg.register(secretRedactorHook());
  }
  if (!cfg || cfg.promptInjectionDetector !== false) {
    reg.register(promptInjectionHook());
  }
  if (!cfg || cfg.discoverGuardrails !== false) {
    reg.register(vaguenessHook(opts.cwd));
    reg.register(contradictionHook(opts.cwd));
    reg.register(multiQuestionHook(opts.cwd));
  }
  return reg;
};

export { dangerousCommandHook } from './dangerous-command.js';
export { pathSafetyHook } from './path-safety.js';
export { secretRedactorHook, redactSecrets } from './secret-redactor.js';
export { promptInjectionHook } from './prompt-injection.js';
export {
  contradictionHook,
  multiQuestionHook,
  vaguenessHook,
  isVagueUserMessage,
  detectContradictions,
  countQuestions
} from './discover-guardrails.js';
