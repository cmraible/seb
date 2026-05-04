/**
 * Per-agent-group pinning for GitHub App installations.
 *
 * The host-side broker (src/github-app/) can mint installation tokens for
 * any installation of the App, and tools that take owner/repo can resolve
 * the installation dynamically. This column lets each agent group default
 * to a specific installation when no owner/repo is in scope — useful when
 * the App is installed on more than one org/account and different agent
 * groups should act as different installations by default.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration014: Migration = {
  version: 14,
  name: 'agent-group-github-installation',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE agent_groups ADD COLUMN github_installation_id INTEGER`);
  },
};
