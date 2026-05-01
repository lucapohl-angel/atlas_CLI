/**
 * Sectioned file writes — grow long-form markdown artifacts (PRD,
 * architecture, etc.) one section at a time. Idempotent: a section is
 * either appended (first time) or replaced in place (every time after).
 *
 * Sections are delimited by HTML-comment markers so they survive any
 * markdown renderer:
 *
 *   <!-- atlas:section <id> -->
 *   <markdown body>
 *   <!-- /atlas:section <id> -->
 *
 * The marker pair is invisible in rendered markdown but trivially
 * grep-able. Multiple sections can coexist in a single file in any
 * order; insertion order is preserved across edits.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { atlasError, type AtlasError } from '../errors.js';
import { err, ok, type Result } from '../result.js';

export interface ApplySectionOptions {
  readonly filePath: string;
  /** Stable section id; must match `[a-z][a-z0-9-]*`. */
  readonly sectionId: string;
  /** Markdown content to live between the markers (no markers needed). */
  readonly content: string;
  /**
   * Optional preamble written verbatim at the top of the file when it
   * does not yet exist. Use this for byte-0-sensitive formats (e.g. a
   * `# Title` header). Ignored if the file already exists.
   */
  readonly preamble?: string;
}

export interface ApplySectionResult {
  /** True if a new section was appended; false if an existing one was replaced. */
  readonly created: boolean;
  /** True if the file did not exist before this call. */
  readonly fileCreated: boolean;
  readonly path: string;
  readonly sectionId: string;
}

const ID_RE = /^[a-z][a-z0-9-]*$/;

const openMarker = (id: string): string => `<!-- atlas:section ${id} -->`;
const closeMarker = (id: string): string => `<!-- /atlas:section ${id} -->`;

const sectionRegion = (id: string): RegExp => {
  // [\s\S] to span newlines; lazy `*?` to stop at the first close marker.
  const open = openMarker(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const close = closeMarker(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${open}[\\s\\S]*?${close}\\n?`, 'm');
};

const buildBlock = (id: string, content: string): string => {
  const trimmed = content.replace(/\s+$/, '');
  return `${openMarker(id)}\n${trimmed}\n${closeMarker(id)}\n`;
};

export const applySectionToFile = async (
  options: ApplySectionOptions
): Promise<Result<ApplySectionResult, AtlasError>> => {
  const { filePath, sectionId, content, preamble } = options;

  if (!ID_RE.test(sectionId)) {
    return err(
      atlasError(
        'TEMPLATE_SECTION_WRITE_FAILED',
        `invalid section id "${sectionId}" — must match ${ID_RE.source}`,
        { context: { sectionId } }
      )
    );
  }

  let existing: string | undefined;
  try {
    existing = await readFile(filePath, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') {
      return err(
        atlasError(
          'TEMPLATE_SECTION_WRITE_FAILED',
          `failed to read ${filePath}`,
          { cause: e, context: { filePath } }
        )
      );
    }
  }

  const block = buildBlock(sectionId, content);
  let next: string;
  let created: boolean;
  const fileCreated = existing === undefined;

  if (existing === undefined) {
    next = (preamble ? `${preamble.replace(/\s+$/, '')}\n\n` : '') + block;
    created = true;
  } else {
    const region = sectionRegion(sectionId);
    if (region.test(existing)) {
      next = existing.replace(region, block);
      created = false;
    } else {
      // Append after the existing content; ensure exactly one blank line
      // between the previous content and the new section.
      const trimmed = existing.replace(/\s+$/, '');
      next = `${trimmed}\n\n${block}`;
      created = true;
    }
  }

  try {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, next, 'utf8');
  } catch (e) {
    return err(
      atlasError(
        'TEMPLATE_SECTION_WRITE_FAILED',
        `failed to write ${filePath}`,
        { cause: e, context: { filePath } }
      )
    );
  }

  return ok({ created, fileCreated, path: filePath, sectionId });
};

/**
 * Read the current body of a marked section from a file, if present.
 * Returns `undefined` when the file or section does not exist.
 */
export const readSectionFromFile = async (
  filePath: string,
  sectionId: string
): Promise<Result<string | undefined, AtlasError>> => {
  if (!ID_RE.test(sectionId)) {
    return err(
      atlasError(
        'TEMPLATE_SECTION_WRITE_FAILED',
        `invalid section id "${sectionId}" — must match ${ID_RE.source}`,
        { context: { sectionId } }
      )
    );
  }
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return ok(undefined);
    return err(
      atlasError(
        'TEMPLATE_SECTION_WRITE_FAILED',
        `failed to read ${filePath}`,
        { cause: e, context: { filePath } }
      )
    );
  }
  const m = sectionRegion(sectionId).exec(raw);
  if (!m) return ok(undefined);
  // Strip the markers and surrounding newlines.
  const inner = m[0]
    .replace(openMarker(sectionId), '')
    .replace(closeMarker(sectionId), '')
    .replace(/^\n/, '')
    .replace(/\n\s*$/, '');
  return ok(inner);
};
