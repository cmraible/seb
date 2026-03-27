import fs from 'fs';
import path from 'path';

import { describe, expect, it, afterEach } from 'vitest';

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

describe('writeGroupTemplate PR templates', () => {
  const testFolders: string[] = [];

  afterEach(() => {
    for (const folder of testFolders) {
      const groupPath = path.join(GROUPS_DIR, folder);
      fs.rmSync(groupPath, { recursive: true, force: true });
    }
    testFolders.length = 0;
  });

  function setupFolder(folder: string): string {
    const groupPath = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(groupPath, { recursive: true });
    testFolders.push(folder);
    return groupPath;
  }

  it('generates PR template with author metadata', () => {
    const folder = 'github_test-pr-author-42';
    const groupPath = setupFolder(folder);

    writeGroupTemplate(folder, 'gh:cmraible/seb#42', {
      type: 'pull_request',
      title: 'Test PR',
      author: 'alice',
    });

    const content = fs.readFileSync(path.join(groupPath, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('**Author**: alice');
    expect(content).toContain('**PR**: #42');
    expect(content).toContain('Confidence: N/10');
    expect(content).toContain('Recommendation: Merge');
    expect(content).not.toContain('This Is Your Own PR');
  });

  it('generates own-PR template for seb-writes-code author', () => {
    const folder = 'github_test-pr-bot-43';
    const groupPath = setupFolder(folder);

    writeGroupTemplate(folder, 'gh:cmraible/seb#43', {
      type: 'pull_request',
      title: 'Bot PR',
      author: 'seb-writes-code',
    });

    const content = fs.readFileSync(path.join(groupPath, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('**Author**: seb-writes-code');
    expect(content).toContain('This Is Your Own PR');
    expect(content).toContain('Address every comment with a code fix');
  });

  it('generates PR template without author when not provided', () => {
    const folder = 'github_test-pr-noauthor-44';
    const groupPath = setupFolder(folder);

    writeGroupTemplate(folder, 'gh:cmraible/seb#44', {
      type: 'pull_request',
      title: 'No author PR',
    });

    const content = fs.readFileSync(path.join(groupPath, 'CLAUDE.md'), 'utf-8');
    expect(content).not.toContain('**Author**');
    expect(content).not.toContain('This Is Your Own PR');
    expect(content).toContain('Review Against Rubric');
  });
});
