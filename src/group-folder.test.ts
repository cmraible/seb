import fs from 'fs';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { GROUPS_DIR } from './config.js';
import {
  isValidGroupFolder,
  resolveGroupFolderPath,
  resolveGroupIpcPath,
  writeGroupTemplate,
} from './group-folder.js';

describe('group folder validation', () => {
  it('accepts normal group folder names', () => {
    expect(isValidGroupFolder('main')).toBe(true);
    expect(isValidGroupFolder('family-chat')).toBe(true);
    expect(isValidGroupFolder('Team_42')).toBe(true);
  });

  it('rejects traversal and reserved names', () => {
    expect(isValidGroupFolder('../../etc')).toBe(false);
    expect(isValidGroupFolder('/tmp')).toBe(false);
    expect(isValidGroupFolder('global')).toBe(false);
    expect(isValidGroupFolder('')).toBe(false);
  });

  it('resolves safe paths under groups directory', () => {
    const resolved = resolveGroupFolderPath('family-chat');
    expect(resolved.endsWith(`${path.sep}groups${path.sep}family-chat`)).toBe(
      true,
    );
  });

  it('resolves safe paths under data ipc directory', () => {
    const resolved = resolveGroupIpcPath('family-chat');
    expect(
      resolved.endsWith(`${path.sep}data${path.sep}ipc${path.sep}family-chat`),
    ).toBe(true);
  });

  it('throws for unsafe folder names', () => {
    expect(() => resolveGroupFolderPath('../../etc')).toThrow();
    expect(() => resolveGroupIpcPath('/tmp')).toThrow();
  });
});

describe('writeGroupTemplate duplicate work prevention', () => {
  const testFolders: string[] = [];

  afterEach(() => {
    for (const folder of testFolders) {
      const dir = path.resolve(GROUPS_DIR, folder);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true });
      }
    }
    testFolders.length = 0;
  });

  function setupFolder(name: string): string {
    testFolders.push(name);
    const dir = path.resolve(GROUPS_DIR, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('Linear issue template includes duplicate work prevention step', () => {
    const folder = 'test-linear-dupcheck';
    const dir = setupFolder(folder);

    writeGroupTemplate(folder, 'linear:CHR-99', {
      title: 'Test issue',
      team: 'Engineering',
    });

    const content = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('Check for existing work');
    expect(content).toContain('mcp__linear__list_issues');
    expect(content).toContain('gh pr list');
    expect(content).toContain('BEFORE writing any code');
  });

  it('GitHub issue template includes duplicate work prevention step', () => {
    const folder = 'test-github-dupcheck';
    const dir = setupFolder(folder);

    writeGroupTemplate(folder, 'gh:cmraible/seb#42', {
      type: 'issue',
      title: 'Test issue',
    });

    const content = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('Check for Existing Work');
    expect(content).toContain('gh pr list --repo cmraible/seb');
    expect(content).toContain('gh issue list --repo cmraible/seb');
  });

  it('GitHub PR template does not include duplicate work prevention', () => {
    const folder = 'test-github-pr-nodupcheck';
    const dir = setupFolder(folder);

    writeGroupTemplate(folder, 'gh:cmraible/seb#10', {
      type: 'pull_request',
      title: 'Test PR',
    });

    const content = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8');
    // PR templates review existing code, they don't create new work
    expect(content).not.toContain('Check for existing work');
  });
});
