/**
 * Re-exported from @atlas/core so both CLI TUI and VS Code: extension share
 * the same self-improvement loop utilities.
 */
export {
  DEFAULT_AUTO_LEARN_ENABLED,
  shouldOfferLearn,
  describeLearnReason,
  buildReflectionMessages,
  buildSkillRevisionMessages,
  parseLearnedSkillDraft,
  type LearnedSkillDraft,
} from '@atlas/core';
