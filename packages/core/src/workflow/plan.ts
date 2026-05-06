/**
 * PLAN.xml — structured execution plan emitted by the planner during
 * the `plan` phase. The XML form is deliberate: the orchestrator can
 * execute it wave by wave, and an XML schema is rigid enough to validate
 * without ambiguity while still being human-readable/editable.
 *
 * Schema:
 *   <plan version="1">
 *     <task id="01" name="...">
 *       <files>
 *         <file>relative/path.ts</file>
 *       </files>
 *       <action>What to do, prose</action>
 *       <verify>shell command(s) that prove it works</verify>
 *       <done>concrete acceptance criteria</done>
 *       <stop_when>optional: budget/abort condition for the executor</stop_when>
 *       <deps>
 *         <dep>00</dep>
 *       </deps>
 *     </task>
 *   </plan>
 *
 * The parser is hand-rolled and strict — anything that doesn't match
 * the schema is rejected with a precise error. We intentionally avoid
 * a generic XML library because plans are constrained enough that a
 * full parser is overkill and a library is one more attack surface.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atlasError, type AtlasError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import { taskDir } from './state.js';
import type { TaskState } from './types.js';

export const PLAN_FILENAME = 'PLAN.xml';

export interface PlanTask {
  readonly id: string;
  readonly name: string;
  readonly files: readonly string[];
  readonly action: string;
  readonly verify: string;
  readonly done: string;
  /** Optional executor budget / abort condition surfaced into the agent goal. */
  readonly stopWhen?: string;
  readonly deps: readonly string[];
}

export interface Plan {
  readonly version: 1;
  readonly tasks: readonly PlanTask[];
}

const planPath = (state: TaskState): string => join(taskDir(state.cwd, state.id), PLAN_FILENAME);

const fileExists = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

const escapeXml = (s: string): string =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

const unescapeXml = (s: string): string =>
  s
    .replaceAll('&apos;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');

/** Serialize a plan to canonical XML (2-space indent). */
export const serializePlan = (plan: Plan): string => {
  const lines: string[] = [`<plan version="${plan.version}">`];
  for (const t of plan.tasks) {
    lines.push(`  <task id="${escapeXml(t.id)}" name="${escapeXml(t.name)}">`);
    lines.push('    <files>');
    for (const f of t.files) lines.push(`      <file>${escapeXml(f)}</file>`);
    lines.push('    </files>');
    lines.push(`    <action>${escapeXml(t.action)}</action>`);
    lines.push(`    <verify>${escapeXml(t.verify)}</verify>`);
    lines.push(`    <done>${escapeXml(t.done)}</done>`);
    if (t.stopWhen && t.stopWhen.trim().length > 0) {
      lines.push(`    <stop_when>${escapeXml(t.stopWhen)}</stop_when>`);
    }
    if (t.deps.length > 0) {
      lines.push('    <deps>');
      for (const d of t.deps) lines.push(`      <dep>${escapeXml(d)}</dep>`);
      lines.push('    </deps>');
    } else {
      lines.push('    <deps/>');
    }
    lines.push('  </task>');
  }
  lines.push('</plan>');
  return lines.join('\n') + '\n';
};

/** Strict regex-based parser. Returns the first parse error encountered. */
export const parsePlan = (xml: string): Result<Plan, AtlasError> => {
  const planMatch = xml.match(/<plan\s+version="(\d+)"\s*>([\s\S]*)<\/plan>/);
  if (!planMatch) {
    return err(atlasError('WORKFLOW_STATE_PARSE_FAILED', 'PLAN.xml: missing <plan version="..."> root'));
  }
  const version = Number(planMatch[1]);
  if (version !== 1) {
    return err(atlasError('WORKFLOW_STATE_PARSE_FAILED', `PLAN.xml: unsupported version ${version}`));
  }
  const inner = planMatch[2] ?? '';
  const tasks: PlanTask[] = [];
  const taskRe = /<task\s+id="([^"]+)"\s+name="([^"]+)"\s*>([\s\S]*?)<\/task>/g;
  for (const m of inner.matchAll(taskRe)) {
    const id = unescapeXml(m[1] ?? '');
    const name = unescapeXml(m[2] ?? '');
    const body = m[3] ?? '';

    const files: string[] = [];
    const filesBlock = body.match(/<files>([\s\S]*?)<\/files>/);
    if (!filesBlock) {
      return err(
        atlasError('WORKFLOW_STATE_PARSE_FAILED', `PLAN.xml: task ${id} missing <files>`)
      );
    }
    for (const fm of (filesBlock[1] ?? '').matchAll(/<file>([\s\S]*?)<\/file>/g)) {
      files.push(unescapeXml((fm[1] ?? '').trim()));
    }
    if (files.length === 0) {
      return err(
        atlasError('WORKFLOW_STATE_PARSE_FAILED', `PLAN.xml: task ${id} <files> is empty`)
      );
    }

    const pickOne = (tag: 'action' | 'verify' | 'done'): Result<string, AtlasError> => {
      const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
      const x = body.match(re);
      if (!x) {
        return err(
          atlasError('WORKFLOW_STATE_PARSE_FAILED', `PLAN.xml: task ${id} missing <${tag}>`)
        );
      }
      return ok(unescapeXml((x[1] ?? '').trim()));
    };
    const action = pickOne('action');
    if (!action.ok) return action;
    const verify = pickOne('verify');
    if (!verify.ok) return verify;
    const done = pickOne('done');
    if (!done.ok) return done;

    const stopWhenMatch = body.match(/<stop_when>([\s\S]*?)<\/stop_when>/);
    const stopWhen = stopWhenMatch ? unescapeXml((stopWhenMatch[1] ?? '').trim()) : undefined;

    const deps: string[] = [];
    const depsBlock = body.match(/<deps>([\s\S]*?)<\/deps>/);
    if (depsBlock) {
      for (const dm of (depsBlock[1] ?? '').matchAll(/<dep>([\s\S]*?)<\/dep>/g)) {
        deps.push(unescapeXml((dm[1] ?? '').trim()));
      }
    }

    tasks.push({
      id,
      name,
      files,
      action: action.value,
      verify: verify.value,
      done: done.value,
      ...(stopWhen && stopWhen.length > 0 ? { stopWhen } : {}),
      deps
    });
  }

  if (tasks.length === 0) {
    return err(atlasError('WORKFLOW_STATE_PARSE_FAILED', 'PLAN.xml: at least one <task> required'));
  }
  return ok({ version: 1, tasks });
};

export interface PlanIssue {
  readonly taskId: string;
  readonly message: string;
}

/**
 * Static checks beyond schema parsing: unique task ids, no unknown
 * deps, no self-deps, no circular deps. Returns the list of issues
 * (empty array means the plan is sound).
 */
export const checkPlan = (plan: Plan): readonly PlanIssue[] => {
  const issues: PlanIssue[] = [];
  const seen = new Set<string>();
  for (const t of plan.tasks) {
    if (seen.has(t.id)) issues.push({ taskId: t.id, message: 'duplicate task id' });
    seen.add(t.id);
    if (!t.action.trim()) issues.push({ taskId: t.id, message: 'empty <action>' });
    if (!t.verify.trim()) issues.push({ taskId: t.id, message: 'empty <verify>' });
    if (!t.done.trim()) issues.push({ taskId: t.id, message: 'empty <done>' });
  }
  for (const t of plan.tasks) {
    for (const d of t.deps) {
      if (d === t.id) issues.push({ taskId: t.id, message: `self-dep ${d}` });
      if (!seen.has(d)) issues.push({ taskId: t.id, message: `unknown dep ${d}` });
    }
  }
  // cycle detection (DFS)
  const adj = new Map(plan.tasks.map((t) => [t.id, t.deps]));
  const color = new Map<string, 'w' | 'g' | 'b'>();
  for (const t of plan.tasks) color.set(t.id, 'w');
  const dfs = (node: string): boolean => {
    color.set(node, 'g');
    for (const nxt of adj.get(node) ?? []) {
      const c = color.get(nxt);
      if (c === 'g') return true;
      if (c === 'w' && dfs(nxt)) return true;
    }
    color.set(node, 'b');
    return false;
  };
  for (const t of plan.tasks) {
    if (color.get(t.id) === 'w' && dfs(t.id)) {
      issues.push({ taskId: t.id, message: 'cycle detected in deps' });
      break;
    }
  }
  return issues;
};

/** Atomic write of PLAN.xml. Validates the input via checkPlan first. */
export const writePlan = async (
  state: TaskState,
  plan: Plan
): Promise<Result<{ readonly path: string; readonly issues: readonly PlanIssue[] }, AtlasError>> => {
  const issues = checkPlan(plan);
  if (issues.length > 0) {
    const detail = issues.map((i) => `[${i.taskId}] ${i.message}`).join('; ');
    return err(
      atlasError('WORKFLOW_STATE_WRITE_FAILED', `plan failed validation: ${detail}`)
    );
  }
  const path = planPath(state);
  try {
    await mkdir(join(path, '..'), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, serializePlan(plan), 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(tmp, path);
    return ok({ path, issues });
  } catch (e) {
    return err(
      atlasError('WORKFLOW_STATE_WRITE_FAILED', 'failed to write PLAN.xml', { cause: e })
    );
  }
};

export const readPlan = async (
  state: TaskState
): Promise<Result<Plan | null, AtlasError>> => {
  const path = planPath(state);
  if (!(await fileExists(path))) return ok(null);
  try {
    const xml = await readFile(path, 'utf8');
    return parsePlan(xml);
  } catch (e) {
    return err(
      atlasError('WORKFLOW_STATE_PARSE_FAILED', 'failed to read PLAN.xml', { cause: e })
    );
  }
};
