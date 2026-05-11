import { isAbsolute, relative, resolve } from 'node:path';
import { atlasError, type AtlasError } from '@atlas/core/errors';
import { err, ok, type Result } from '@atlas/core/result';

export interface UriLike {
  readonly fsPath: string;
  toString(): string;
}

export interface PositionLike {
  readonly line: number;
  readonly character: number;
}

export interface RangeLike {
  readonly start: PositionLike;
  readonly end: PositionLike;
}

export interface TextDocumentLike {
  readonly uri: UriLike;
  getText(): string;
  positionAt(offset: number): PositionLike;
}

export interface WorkspaceEditLike {
  replace(uri: UriLike, range: RangeLike, newText: string): void;
  createFile(uri: UriLike, options?: {
    readonly overwrite?: boolean;
    readonly ignoreIfExists?: boolean;
    readonly contents?: Uint8Array;
  }): void;
}

export interface EventLike<T> {
  (listener: (event: T) => unknown): { dispose(): unknown };
}

export interface EventEmitterLike<T> {
  readonly event: EventLike<T>;
  fire(event: T): void;
  dispose(): void;
}

export interface PseudoterminalLike {
  readonly onDidWrite: EventLike<string>;
  readonly onDidClose?: EventLike<number | void>;
  open(initialDimensions: unknown): void;
  close(): void;
}

export interface TerminalLike {
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

export interface VsCodeToolHost {
  readonly Uri: {
    file(path: string): UriLike;
  };
  readonly Position: new (line: number, character: number) => PositionLike;
  readonly Range: new (start: PositionLike, end: PositionLike) => RangeLike;
  readonly WorkspaceEdit: new () => WorkspaceEditLike;
  readonly EventEmitter: new <T>() => EventEmitterLike<T>;
  readonly FileType: {
    readonly File: number;
  };
  readonly workspace: {
    readonly fs: {
      stat(uri: UriLike): PromiseLike<{ readonly type: number; readonly size: number }>;
      readFile(uri: UriLike): PromiseLike<Uint8Array>;
      writeFile(uri: UriLike, content: Uint8Array): PromiseLike<void>;
      createDirectory(uri: UriLike): PromiseLike<void>;
    };
    openTextDocument(uri: UriLike): PromiseLike<TextDocumentLike>;
    applyEdit(edit: WorkspaceEditLike): PromiseLike<boolean>;
  };
  readonly window: {
    showInformationMessage<T extends string>(
      message: string,
      options: { readonly modal?: boolean; readonly detail?: string },
      ...items: readonly T[]
    ): PromiseLike<T | undefined>;
    showInputBox(options: {
      readonly title?: string;
      readonly prompt?: string;
      readonly ignoreFocusOut?: boolean;
    }): PromiseLike<string | undefined>;
    showQuickPick<T extends string>(
      items: readonly T[],
      options: { readonly title?: string; readonly placeHolder?: string; readonly ignoreFocusOut?: boolean },
    ): PromiseLike<T | undefined>;
    createTerminal(options: {
      readonly name: string;
      readonly pty: PseudoterminalLike;
      readonly isTransient?: boolean;
    }): TerminalLike;
  };
}

export interface ResolvedWorkspacePath {
  readonly abs: string;
  readonly rel: string;
}

export const resolveWorkspacePath = (
  cwd: string,
  inputPath: string,
): Result<ResolvedWorkspacePath, AtlasError> => {
  const abs = isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath);
  const rel = relative(cwd, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return err(atlasError('TOOL_EXECUTION_FAILED', `path escapes cwd: ${inputPath}`, {
      context: { path: inputPath, cwd },
    }));
  }
  return ok({ abs, rel });
};


export const isRegularFile = (
  host: VsCodeToolHost,
  stat: { readonly type: number },
): boolean => (stat.type & host.FileType.File) !== 0;

export const isMissingFileError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { readonly code?: unknown; readonly name?: unknown; readonly message?: unknown };
  return candidate.code === 'FileNotFound'
    || candidate.code === 'ENOENT'
    || candidate.name === 'FileSystemError'
    || (typeof candidate.message === 'string' && candidate.message.includes('FileNotFound'));
};

export const truncateForPreview = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;
  const headChars = Math.floor(maxChars * 0.65);
  const tailChars = Math.max(0, maxChars - headChars - 48);
  return [
    text.slice(0, headChars),
    `\n...(truncated ${text.length - headChars - tailChars} chars)...\n`,
    tailChars > 0 ? text.slice(-tailChars) : '',
  ].join('');
};

export const formatUnknown = (input: unknown, maxChars = 4_000): string => {
  if (typeof input === 'string') return truncateForPreview(input, maxChars);
  try {
    return truncateForPreview(JSON.stringify(input, null, 2) ?? String(input), maxChars);
  } catch {
    return String(input);
  }
};