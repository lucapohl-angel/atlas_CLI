import { describe, expect, it } from 'vitest';
import type { Plan, PlanTask } from './plan.js';
import { groupIntoWaves } from './waves.js';

const t = (id: string, deps: readonly string[] = []): PlanTask => ({
  id,
  name: id,
  files: ['x.ts'],
  action: 'a',
  verify: 'v',
  done: 'd',
  deps
});

describe('workflow/waves: groupIntoWaves', () => {
  it('returns one wave when there are no deps', () => {
    const plan: Plan = { version: 1, tasks: [t('01'), t('02'), t('03')] };
    const r = groupIntoWaves(plan);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.length).toBe(1);
      expect(r.value[0]!.map((x) => x.id).sort()).toEqual(['01', '02', '03']);
    }
  });

  it('linear deps produce one wave per task in dependency order', () => {
    const plan: Plan = {
      version: 1,
      tasks: [t('01'), t('02', ['01']), t('03', ['02'])]
    };
    const r = groupIntoWaves(plan);
    if (r.ok) {
      expect(r.value.length).toBe(3);
      expect(r.value[0]!.map((x) => x.id)).toEqual(['01']);
      expect(r.value[1]!.map((x) => x.id)).toEqual(['02']);
      expect(r.value[2]!.map((x) => x.id)).toEqual(['03']);
    }
  });

  it('groups parallel tasks that depend on the same predecessor', () => {
    const plan: Plan = {
      version: 1,
      tasks: [t('01'), t('02', ['01']), t('03', ['01']), t('04', ['02', '03'])]
    };
    const r = groupIntoWaves(plan);
    if (r.ok) {
      expect(r.value.length).toBe(3);
      expect(r.value[0]!.map((x) => x.id)).toEqual(['01']);
      expect(r.value[1]!.map((x) => x.id).sort()).toEqual(['02', '03']);
      expect(r.value[2]!.map((x) => x.id)).toEqual(['04']);
    }
  });

  it('rejects duplicate task ids', () => {
    const plan: Plan = { version: 1, tasks: [t('01'), t('01')] };
    const r = groupIntoWaves(plan);
    expect(r.ok).toBe(false);
  });

  it('rejects unsatisfiable deps (would have been caught by checkPlan)', () => {
    const plan: Plan = { version: 1, tasks: [t('01', ['99'])] };
    const r = groupIntoWaves(plan);
    expect(r.ok).toBe(false);
  });
});
