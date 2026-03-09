import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GROUPS_DIR } from './config.js';
import { copyGroupTemplate, getTemplateName } from './group-folder.js';

describe('getTemplateName', () => {
  it('returns github-pr for PR folder patterns', () => {
    expect(getTemplateName('github_cmraible-seb-42')).toBe('github-pr');
    expect(getTemplateName('github_owner-repo-1')).toBe('github-pr');
    expect(getTemplateName('github_some-org-big-repo-999')).toBe('github-pr');
  });

  it('returns null for non-PR GitHub folders', () => {
    expect(getTemplateName('github_cmraible-seb')).toBeNull();
  });

  it('returns null for non-GitHub folders', () => {
    expect(getTemplateName('telegram_dev-team')).toBeNull();
    expect(getTemplateName('main')).toBeNull();
    expect(getTemplateName('whatsapp_family-chat')).toBeNull();
  });
});

describe('copyGroupTemplate', () => {
  const testFolder = 'github_test-repo-99';
  const groupDir = path.join(GROUPS_DIR, testFolder);
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');

  beforeEach(() => {
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(groupDir, { recursive: true, force: true });
  });

  it('copies template CLAUDE.md into a new GitHub PR group folder', () => {
    copyGroupTemplate(testFolder);
    expect(fs.existsSync(claudeMdPath)).toBe(true);
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).toContain('GitHub PR Agent');
    expect(content).toContain('Check Suite Failure');
  });

  it('does not overwrite an existing CLAUDE.md', () => {
    fs.writeFileSync(claudeMdPath, 'custom instructions');
    copyGroupTemplate(testFolder);
    expect(fs.readFileSync(claudeMdPath, 'utf-8')).toBe('custom instructions');
  });

  it('does nothing for non-matching folder patterns', () => {
    const nonPrFolder = 'telegram_dev-team';
    const nonPrDir = path.join(GROUPS_DIR, nonPrFolder);
    fs.mkdirSync(path.join(nonPrDir, 'logs'), { recursive: true });
    try {
      copyGroupTemplate(nonPrFolder);
      expect(
        fs.existsSync(path.join(nonPrDir, 'CLAUDE.md')),
      ).toBe(false);
    } finally {
      fs.rmSync(nonPrDir, { recursive: true, force: true });
    }
  });
});
