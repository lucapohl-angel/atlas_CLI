#!/usr/bin/env node
/**
 * Keep local workspace installs on pnpm. The published atlas-os package
 * remains installable with npm/yarn/bun; this guard only lives at the
 * private monorepo root.
 */
const agent = process.env.npm_config_user_agent ?? '';
const execPath = process.env.npm_execpath ?? '';

const isPnpm = agent.startsWith('pnpm/') || /pnpm/i.test(execPath);
if (isPnpm) process.exit(0);

const msg = [
  'atlas-os-monorepo uses pnpm workspaces.',
  '',
  'Install pnpm once, then reinstall:',
  '  npm install -g pnpm@10.33.2',
  '  pnpm install',
  '',
  'If your Node distribution ships Corepack, this also works:',
  '  corepack enable',
  '  corepack prepare pnpm@10.33.2 --activate',
  '  pnpm install'
].join('\n');

console.error(msg);
process.exit(1);