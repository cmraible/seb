/**
 * GitHub App broker — host-side service that holds the App private key,
 * mints installation access tokens, and exposes a small JSON tool surface.
 *
 * The container never sees the private key. A stdio MCP bridge inside the
 * container forwards tool calls here over loopback HTTP using a shared
 * token (auto-generated at startup, written to data/github-app-broker.token,
 * injected into containers as env by container-runner).
 */
import { loadGitHubAppConfig } from './config.js';
import { startGitHubAppBroker } from './server.js';
import { log } from '../log.js';

export { getActiveBroker, stopGitHubAppBroker, BROKER_TOKEN_FILE } from './server.js';

export async function maybeStartGitHubAppBroker(): Promise<void> {
  const config = loadGitHubAppConfig();
  if (!config) {
    log.debug('GitHub App broker not configured — set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY_PATH to enable');
    return;
  }
  try {
    await startGitHubAppBroker(config);
  } catch (err) {
    log.warn('GitHub App broker failed to start', { err: String(err) });
  }
}
