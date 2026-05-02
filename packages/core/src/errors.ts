/**
 * Atlas error hierarchy — all recoverable errors extend AtlasError.
 *
 * Error codes are stable strings used for programmatic dispatch.
 * Messages are human-readable and may change; codes must not.
 */

export type AtlasErrorCode =
  // Configuration
  | 'CONFIG_INVALID'
  | 'CONFIG_MISSING'
  | 'CONFIG_WRITE_FAILED'
  // Provider
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_NETWORK'
  | 'PROVIDER_INVALID_RESPONSE'
  | 'PROVIDER_MODEL_UNKNOWN'
  // Tool
  | 'TOOL_NOT_FOUND'
  | 'TOOL_INPUT_INVALID'
  | 'TOOL_EXECUTION_FAILED'
  | 'TOOL_BLOCKED_BY_HOOK'
  | 'TOOL_DENIED_BY_USER'
  | 'TOOL_CANCELLED'
  // Hook
  | 'HOOK_INVALID'
  | 'HOOK_LOAD_FAILED'
  // Skill / Agent
  | 'SKILL_NOT_FOUND'
  | 'SKILL_PARSE_FAILED'
  | 'AGENT_NOT_FOUND'
  | 'AGENT_PARSE_FAILED'
  // Session
  | 'SESSION_NOT_FOUND'
  | 'SESSION_CORRUPT'
  // Story / Handoff
  | 'STORY_NOT_FOUND'
  | 'STORY_PARSE_FAILED'
  | 'STORY_SECTION_FORBIDDEN'
  | 'STORY_SECTION_MISSING'
  | 'HANDOFF_NOT_FOUND'
  | 'HANDOFF_PARSE_FAILED'
  // Template
  | 'TEMPLATE_NOT_FOUND'
  | 'TEMPLATE_PARSE_FAILED'
  | 'TEMPLATE_OWNER_MISMATCH'
  | 'TEMPLATE_INPUT_MISSING'
  | 'TEMPLATE_RENDER_FAILED'
  | 'TEMPLATE_SECTION_NOT_FOUND'
  | 'TEMPLATE_SECTION_WRITE_FAILED'
  // Checklist
  | 'CHECKLIST_NOT_FOUND'
  | 'CHECKLIST_PARSE_FAILED'
  | 'CHECKLIST_OWNER_MISMATCH'
  | 'CHECKLIST_INPUT_INVALID'
  // Workflow
  | 'CHAIN_PARSE_FAILED'
  // Project state
  | 'STATE_PARSE_FAILED'
  | 'STATE_WRITE_FAILED'
  | 'STATE_STORY_NOT_FOUND'
  | 'STATE_EPIC_NOT_FOUND'
  // Onboarding
  | 'ONBOARDING_SCAN_FAILED'
  | 'ONBOARDING_WRITE_FAILED'
  // Generic
  | 'INTERNAL'
  | 'CANCELLED'
  | 'TIMEOUT';

export interface AtlasErrorDetails {
  readonly code: AtlasErrorCode;
  readonly message: string;
  readonly cause?: unknown;
  readonly recoverable?: boolean;
  readonly context?: Readonly<Record<string, unknown>>;
}

export class AtlasError extends Error {
  public readonly code: AtlasErrorCode;
  public readonly recoverable: boolean;
  public readonly context: Readonly<Record<string, unknown>>;
  public override readonly cause: unknown;

  constructor(details: AtlasErrorDetails) {
    super(details.message);
    this.name = 'AtlasError';
    this.code = details.code;
    this.recoverable = details.recoverable ?? true;
    this.context = details.context ?? {};
    this.cause = details.cause;
    // Preserve prototype chain when extending built-ins under TS down-leveling.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  public toJSON(): AtlasErrorDetails {
    return {
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      context: this.context,
      cause: this.cause instanceof Error ? this.cause.message : this.cause
    };
  }
}

/**
 * Convenience factory for the common case where you only have a code + message.
 */
export const atlasError = (
  code: AtlasErrorCode,
  message: string,
  extra: Omit<AtlasErrorDetails, 'code' | 'message'> = {}
): AtlasError => new AtlasError({ code, message, ...extra });

/**
 * Type guard for AtlasError. Useful at error boundaries.
 */
export const isAtlasError = (value: unknown): value is AtlasError =>
  value instanceof AtlasError;
