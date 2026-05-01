/**
 * Story file loader. Reads `docs/stories/<id>.md`, validates frontmatter
 * against `StoryFrontmatterSchema`, and splits the body into H2 sections.
 *
 * The section split treats lines beginning with `## ` (exactly two
 * hashes + space) as section headers; everything before the first such
 * line is discarded as preamble. Section titles are the literal text
 * after `## ` with surrounding whitespace trimmed.
 */
import { readFile } from 'node:fs/promises';
import matter from 'gray-matter';
import { atlasError, type AtlasError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import { StoryFrontmatterSchema, type Story, type StorySection } from './types.js';

export const splitSections = (body: string): readonly StorySection[] => {
  const lines = body.split('\n');
  const sections: StorySection[] = [];
  let current: { title: string; lines: string[] } | null = null;
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m && m[1] !== undefined) {
      if (current) sections.push({ title: current.title, body: current.lines.join('\n').trim() });
      current = { title: m[1], lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) sections.push({ title: current.title, body: current.lines.join('\n').trim() });
  return sections;
};

export const parseStory = (raw: string, path: string): Result<Story, AtlasError> => {
  const parsed = matter(raw);
  const fm = StoryFrontmatterSchema.safeParse(parsed.data);
  if (!fm.success) {
    return err(
      atlasError('STORY_PARSE_FAILED', `invalid story frontmatter at ${path}`, {
        context: { issues: fm.error.issues }
      })
    );
  }
  return ok({
    frontmatter: fm.data,
    sections: splitSections(parsed.content),
    path,
    rawBody: parsed.content
  });
};

export const loadStory = async (path: string): Promise<Result<Story, AtlasError>> => {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') {
      return err(atlasError('STORY_NOT_FOUND', `no story at ${path}`));
    }
    return err(atlasError('STORY_PARSE_FAILED', `failed to read story ${path}`, { cause: e }));
  }
  return parseStory(raw, path);
};
