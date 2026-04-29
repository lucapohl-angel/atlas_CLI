/**
 * Project state detector. Pure side-effecting reads — no decisions.
 *
 * The orchestrator (decide.ts) maps state → recommended agent. Splitting
 * detection from decision keeps both unit-testable.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface ProjectState {
  readonly cwd: string;
  readonly hasGit: boolean;
  readonly hasPRD: boolean;
  readonly hasArchitecture: boolean;
  readonly hasStories: boolean;
  readonly storyCount: number;
  readonly hasUncommittedChanges: boolean;
}

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

const isFile = async (p: string): Promise<boolean> => {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
};

const countMdFiles = async (p: string): Promise<number> => {
  try {
    const entries = await readdir(p);
    return entries.filter((e) => e.endsWith('.md')).length;
  } catch {
    return 0;
  }
};

export const detectProjectState = async (cwd: string): Promise<ProjectState> => {
  const [hasGit, hasPRD, hasArch, storyCount] = await Promise.all([
    exists(join(cwd, '.git')),
    isFile(join(cwd, 'docs', 'prd.md')),
    isFile(join(cwd, 'docs', 'architecture.md')),
    countMdFiles(join(cwd, 'docs', 'stories'))
  ]);

  return {
    cwd,
    hasGit,
    hasPRD,
    hasArchitecture: hasArch,
    hasStories: storyCount > 0,
    storyCount,
    // Detecting uncommitted changes requires `git status` shell-out; the
    // orchestrator can supply this from a hook if needed. Keep cheap by
    // default.
    hasUncommittedChanges: false
  };
};
