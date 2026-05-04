import fs from 'fs';

import { readEnvFile } from '../env.js';

export interface GitHubAppConfig {
  appId: string;
  privateKeyPem: string;
  bind: string;
  port: number;
  defaultInstallationId?: number;
}

export function loadGitHubAppConfig(): GitHubAppConfig | null {
  const env = readEnvFile([
    'GITHUB_APP_ID',
    'GITHUB_APP_PRIVATE_KEY_PATH',
    'GITHUB_APP_BROKER_BIND',
    'GITHUB_APP_BROKER_PORT',
    'GITHUB_APP_DEFAULT_INSTALLATION_ID',
  ]);

  const appId = process.env.GITHUB_APP_ID || env.GITHUB_APP_ID;
  const keyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH || env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (!appId || !keyPath) return null;

  const privateKeyPem = fs.readFileSync(keyPath, 'utf-8');
  if (!privateKeyPem.includes('PRIVATE KEY')) {
    throw new Error(`GITHUB_APP_PRIVATE_KEY_PATH does not look like a PEM key: ${keyPath}`);
  }

  const bind = process.env.GITHUB_APP_BROKER_BIND || env.GITHUB_APP_BROKER_BIND || '0.0.0.0';
  const port = parseInt(process.env.GITHUB_APP_BROKER_PORT || env.GITHUB_APP_BROKER_PORT || '47475', 10);
  const installationStr = process.env.GITHUB_APP_DEFAULT_INSTALLATION_ID || env.GITHUB_APP_DEFAULT_INSTALLATION_ID;
  const defaultInstallationId = installationStr ? parseInt(installationStr, 10) : undefined;

  return { appId, privateKeyPem, bind, port, defaultInstallationId };
}
