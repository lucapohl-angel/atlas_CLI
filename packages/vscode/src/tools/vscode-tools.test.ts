import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowAllPolicy, invokeTool } from '@atlas/core/tools';
import {
  createVsCodeApprovalPolicy,
  createVsCodeToolRegistry,
} from './index.js';
import type {
  EventLike,
  EventEmitterLike,
  PositionLike,
  PseudoterminalLike,
  RangeLike,
  TerminalLike,
  TextDocumentLike,
  UriLike,
  VsCodeToolHost,
  WorkspaceEditLike,
} from './types.js';

describe('VS Code native tools', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-vscode-tools-'));
  });

  afterEach(async () => {
    await import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true }));
  });

  it('registers VS Code adapters over the core file/edit/terminal tools', () => {
    const { host } = createFakeHost();
    const registry = createVsCodeToolRegistry(host);

    expect(registry.has('read_file')).toBe(true);
    expect(registry.has('write_file')).toBe(true);
    expect(registry.has('edit_file')).toBe(true);
    expect(registry.has('terminal')).toBe(true);
    expect(registry.has('clarify')).toBe(true);
  });

  it('read_file sees unsaved editor contents', async () => {
    const { host, setUnsaved } = createFakeHost();
    const file = join(dir, 'note.txt');
    await writeFile(file, 'disk text', 'utf8');
    setUnsaved(file, 'unsaved text');

    const result = await invokeTool(createVsCodeToolRegistry(host), 'read_file', { path: 'note.txt' }, {
      cwd: dir,
      approve: allowAllPolicy,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.summary).toContain('unsaved text');
    expect((result.value.data as { readonly content: string }).content).toBe('unsaved text');
  });

  it('write_file writes through workspace.fs', async () => {
    const { host } = createFakeHost();
    const result = await invokeTool(
      createVsCodeToolRegistry(host),
      'write_file',
      { path: 'sub/out.txt', content: 'from vscode' },
      { cwd: dir, approve: allowAllPolicy },
    );

    expect(result.ok).toBe(true);
    expect(await readFile(join(dir, 'sub/out.txt'), 'utf8')).toBe('from vscode');
  });

  it('edit_file applies changes through WorkspaceEdit', async () => {
    const fake = createFakeHost();
    const file = join(dir, 'edit.txt');
    await writeFile(file, 'alpha\nbeta\n', 'utf8');

    const result = await invokeTool(
      createVsCodeToolRegistry(fake.host),
      'edit_file',
      { path: 'edit.txt', edits: [{ oldString: 'beta', newString: 'gamma' }] },
      { cwd: dir, approve: allowAllPolicy },
    );

    expect(result.ok).toBe(true);
    expect(fake.appliedEdits).toBe(1);
    expect(await readFile(file, 'utf8')).toBe('alpha\ngamma\n');
  });

  it('approval policy uses VS Code modal choices', async () => {
    const { host, setApprovalChoice } = createFakeHost();
    const policy = createVsCodeApprovalPolicy(host);

    setApprovalChoice('Allow');
    await expect(policy.decide('terminal', { command: 'pnpm test' })).resolves.toEqual({ action: 'allow' });

    setApprovalChoice('Deny');
    await expect(policy.decide('terminal', { command: 'rm -rf .' })).resolves.toEqual({
      action: 'deny',
      reason: 'denied in VS Code approval prompt',
    });
  });

  it('approval policy prefers inline webview decisions', async () => {
    const { host, setApprovalChoice } = createFakeHost();
    const policy = createVsCodeApprovalPolicy(host, {
      request: async () => ({ action: 'allow' }),
    });

    setApprovalChoice('Deny');
    await expect(policy.decide('terminal', { command: 'pnpm test' })).resolves.toEqual({ action: 'allow' });
  });

  it('terminal runs a command through a pseudoterminal', async () => {
    const { host } = createFakeHost();
    const result = await invokeTool(
      createVsCodeToolRegistry(host),
      'terminal',
      { command: "printf 'hi'", timeoutMs: 5_000 },
      { cwd: dir, approve: allowAllPolicy },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data as { readonly exitCode: number; readonly stdout: string };
    expect(data.exitCode).toBe(0);
    expect(data.stdout).toBe('hi');
  });
});

class FakeUri implements UriLike {
  public constructor(public readonly fsPath: string) {}
  public toString(): string {
    return `file://${this.fsPath}`;
  }
}

class FakePosition implements PositionLike {
  public constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
}

class FakeRange implements RangeLike {
  public constructor(
    public readonly start: PositionLike,
    public readonly end: PositionLike,
  ) {}
}

type EditOperation =
  | { readonly kind: 'replace'; readonly uri: UriLike; readonly newText: string }
  | { readonly kind: 'createFile'; readonly uri: UriLike; readonly contents: Uint8Array };

class FakeWorkspaceEdit implements WorkspaceEditLike {
  public readonly operations: EditOperation[] = [];

  public replace(uri: UriLike, _range: RangeLike, newText: string): void {
    this.operations.push({ kind: 'replace', uri, newText });
  }

  public createFile(uri: UriLike, options?: { readonly contents?: Uint8Array }): void {
    this.operations.push({ kind: 'createFile', uri, contents: options?.contents ?? new Uint8Array() });
  }
}

class FakeEventEmitter<T> implements EventEmitterLike<T> {
  private readonly listeners = new Set<(event: T) => unknown>();

  public readonly event: EventLike<T> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  public fire(event: T): void {
    for (const listener of this.listeners) listener(event);
  }

  public dispose(): void {
    this.listeners.clear();
  }
}

class FakeTextDocument implements TextDocumentLike {
  public constructor(
    public readonly uri: UriLike,
    private readonly text: string,
  ) {}

  public getText(): string {
    return this.text;
  }

  public positionAt(offset: number): PositionLike {
    const prefix = this.text.slice(0, offset);
    const lines = prefix.split('\n');
    const lastLine = lines[lines.length - 1] ?? '';
    return new FakePosition(lines.length - 1, lastLine.length);
  }
}

const createFakeHost = (): {
  readonly host: VsCodeToolHost;
  readonly setUnsaved: (path: string, text: string) => void;
  readonly setApprovalChoice: (choice: 'Allow' | 'Deny' | undefined) => void;
  readonly appliedEdits: number;
} => {
  const unsaved = new Map<string, string>();
  let approvalChoice: 'Allow' | 'Deny' | undefined = 'Allow';
  let appliedEdits = 0;

  const host: VsCodeToolHost = {
    Uri: { file: (path) => new FakeUri(path) },
    Position: FakePosition,
    Range: FakeRange,
    WorkspaceEdit: FakeWorkspaceEdit,
    EventEmitter: FakeEventEmitter,
    FileType: { File: 1 },
    workspace: {
      fs: {
        async stat(uri) {
          const stats = await stat(uri.fsPath);
          return { type: stats.isFile() ? 1 : 2, size: stats.size };
        },
        async readFile(uri) {
          return await readFile(uri.fsPath);
        },
        async writeFile(uri, content) {
          await writeFile(uri.fsPath, content);
        },
        async createDirectory(uri) {
          await mkdir(uri.fsPath, { recursive: true });
        },
      },
      async openTextDocument(uri) {
        return new FakeTextDocument(uri, unsaved.get(uri.fsPath) ?? await readFile(uri.fsPath, 'utf8'));
      },
      async applyEdit(edit) {
        if (!(edit instanceof FakeWorkspaceEdit)) return false;
        for (const operation of edit.operations) {
          appliedEdits += 1;
          if (operation.kind === 'replace') {
            await writeFile(operation.uri.fsPath, operation.newText, 'utf8');
          } else {
            await mkdir(dirname(operation.uri.fsPath), { recursive: true });
            await writeFile(operation.uri.fsPath, operation.contents);
          }
        }
        return true;
      },
    },
    window: {
      async showInformationMessage<T extends string>(_message: string, _options: unknown, ...items: readonly T[]): Promise<T | undefined> {
        if (approvalChoice === undefined) return undefined;
        return items.find((item) => item === approvalChoice);
      },
      async showInputBox() {
        return 'typed answer';
      },
      async showQuickPick(items) {
        return items[0];
      },
      createTerminal(options: { readonly pty: PseudoterminalLike }): TerminalLike {
        queueMicrotask(() => options.pty.open(undefined));
        return {
          show: () => undefined,
          dispose: () => undefined,
        };
      },
    },
  };

  return {
    host,
    setUnsaved: (path, text) => unsaved.set(path, text),
    setApprovalChoice: (choice) => {
      approvalChoice = choice;
    },
    get appliedEdits() {
      return appliedEdits;
    },
  };
};
