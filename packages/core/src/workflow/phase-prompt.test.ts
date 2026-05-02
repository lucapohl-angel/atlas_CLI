import { describe, expect, it } from 'vitest';
import { phasePromptAddendum } from './phase-prompt.js';

describe('workflow/phase-prompt', () => {
  it('returns null for idle / execute / verify / ship / null', () => {
    expect(phasePromptAddendum(null)).toBeNull();
    expect(phasePromptAddendum('idle')).toBeNull();
    expect(phasePromptAddendum('execute')).toBeNull();
    expect(phasePromptAddendum('verify')).toBeNull();
    expect(phasePromptAddendum('ship')).toBeNull();
  });

  it('discover addendum mentions slot tools and clarify-with-options', () => {
    const a = phasePromptAddendum('discover');
    expect(a).not.toBeNull();
    if (a) {
      expect(a).toContain('context_set');
      expect(a).toContain('context_status');
      expect(a).toContain('context_finalize');
      expect(a).toContain('clarify');
      expect(a).toContain('2–4 plausible options');
      expect(a).toContain('"Other"');
    }
  });

  it('plan addendum mentions stopWhen budgets', () => {
    const a = phasePromptAddendum('plan');
    expect(a).not.toBeNull();
    if (a) {
      expect(a).toContain('stopWhen');
      expect(a).toContain('plan_write');
    }
  });
});
