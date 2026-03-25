import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import type { HealthChecker, HealthCheckResult } from './types.js';

/**
 * Make a lightweight GraphQL request to the Linear API.
 * Returns the parsed JSON body or throws on failure.
 */
async function linearApiRequest(
  token: string,
  query: string,
): Promise<Record<string, unknown>> {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: token,
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    throw new Error(`Linear API returned ${res.status}: ${res.statusText}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

function getLinearToken(): string | undefined {
  // Check process.env first, then .env file
  if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY;
  const env = readEnvFile(['LINEAR_API_KEY']);
  return env.LINEAR_API_KEY || undefined;
}

export class LinearHealthChecker implements HealthChecker {
  name = 'linear';

  async check(): Promise<HealthCheckResult> {
    const timestamp = new Date().toISOString();
    const token = getLinearToken();

    if (!token) {
      return {
        checker: this.name,
        status: 'down',
        details: 'LINEAR_API_KEY not configured',
        timestamp,
      };
    }

    try {
      const data = await linearApiRequest(
        token,
        '{ viewer { id name email active } }',
      );

      const viewer = (data as { data?: { viewer?: Record<string, unknown> } })
        ?.data?.viewer;

      if (!viewer) {
        return {
          checker: this.name,
          status: 'down',
          details: 'Linear API returned no viewer data — token may be invalid',
          timestamp,
        };
      }

      if (viewer.active === false) {
        return {
          checker: this.name,
          status: 'degraded',
          details: `Linear user "${viewer.name}" is deactivated`,
          timestamp,
        };
      }

      return {
        checker: this.name,
        status: 'healthy',
        details: `Authenticated as ${viewer.name} (${viewer.email})`,
        timestamp,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, 'Linear health check failed');
      return {
        checker: this.name,
        status: 'down',
        details: `Linear API error: ${message}`,
        timestamp,
      };
    }
  }
}
