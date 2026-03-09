import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';

const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_FOLDERS = new Set(['global']);

export function isValidGroupFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid group folder "${folder}"`);
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

export function resolveGroupFolderPath(folder: string): string {
  assertValidGroupFolder(folder);
  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}

const TEMPLATES_DIR = path.resolve(GROUPS_DIR, '_templates');

/**
 * Copy a CLAUDE.md template into a newly created group folder
 * if the folder matches a known template pattern and doesn't already have one.
 *
 * Currently supports:
 *  - `github_*-{number}` folders → `_templates/github-pr/CLAUDE.md`
 */
export function copyGroupTemplate(folder: string): void {
  const groupDir = resolveGroupFolderPath(folder);
  const targetPath = path.join(groupDir, 'CLAUDE.md');

  // Don't overwrite existing CLAUDE.md
  if (fs.existsSync(targetPath)) return;

  // Determine which template to use based on folder name pattern
  const templateName = getTemplateName(folder);
  if (!templateName) return;

  const templatePath = path.join(TEMPLATES_DIR, templateName, 'CLAUDE.md');
  if (!fs.existsSync(templatePath)) return;

  fs.copyFileSync(templatePath, targetPath);
}

/** Map a group folder name to a template name, or null if no template applies. */
export function getTemplateName(folder: string): string | null {
  // github_owner-repo-123 → github-pr template
  if (/^github_.+-\d+$/.test(folder)) return 'github-pr';
  return null;
}

export function resolveGroupIpcPath(folder: string): string {
  assertValidGroupFolder(folder);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, folder);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}
