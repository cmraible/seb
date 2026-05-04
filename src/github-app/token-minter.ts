import crypto from 'crypto';

const GITHUB_API = 'https://api.github.com';
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface CachedToken {
  token: string;
  expiresAt: number;
}

interface CachedRepoInstallation {
  installationId: number;
  expiresAt: number;
}

const REPO_INSTALLATION_TTL_MS = 60 * 60 * 1000;

function base64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export class TokenMinter {
  private installationTokens = new Map<number, CachedToken>();
  private repoInstallations = new Map<string, CachedRepoInstallation>();

  constructor(
    private readonly appId: string,
    private readonly privateKeyPem: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Sign a 10-minute App JWT (RS256) for app-level GitHub calls. */
  signAppJwt(now: number = Date.now()): string {
    const iat = Math.floor(now / 1000) - 30;
    const exp = iat + 9 * 60;
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = { iat, exp, iss: this.appId };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signingInput);
    const signature = base64url(signer.sign(this.privateKeyPem));
    return `${signingInput}.${signature}`;
  }

  /** Get a valid installation access token, minting + caching as needed. */
  async getInstallationToken(installationId: number): Promise<string> {
    const cached = this.installationTokens.get(installationId);
    if (cached && cached.expiresAt - REFRESH_BUFFER_MS > Date.now()) {
      return cached.token;
    }
    const minted = await this.mintInstallationToken(installationId);
    this.installationTokens.set(installationId, minted);
    return minted.token;
  }

  /** Resolve owner/repo to an installation id, caching the mapping. */
  async getInstallationForRepo(owner: string, repo: string): Promise<number> {
    const key = `${owner}/${repo}`.toLowerCase();
    const cached = this.repoInstallations.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.installationId;

    const jwt = this.signAppJwt();
    const res = await this.fetchImpl(`${GITHUB_API}/repos/${owner}/${repo}/installation`, {
      headers: this.appAuthHeaders(jwt),
    });
    if (!res.ok) {
      throw new Error(`GitHub repo installation lookup failed (${res.status}): ${await res.text()}`);
    }
    const body = (await res.json()) as { id: number };
    this.repoInstallations.set(key, { installationId: body.id, expiresAt: Date.now() + REPO_INSTALLATION_TTL_MS });
    return body.id;
  }

  /** Headers for App-level (JWT) GitHub calls. */
  appAuthHeaders(jwt: string): Record<string, string> {
    return {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'nanoclaw-github-app-broker',
    };
  }

  /** Headers for installation-token GitHub calls. */
  installationHeaders(token: string): Record<string, string> {
    return {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'nanoclaw-github-app-broker',
    };
  }

  private async mintInstallationToken(installationId: number): Promise<CachedToken> {
    const jwt = this.signAppJwt();
    const res = await this.fetchImpl(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: this.appAuthHeaders(jwt),
    });
    if (!res.ok) {
      throw new Error(`GitHub installation token mint failed (${res.status}): ${await res.text()}`);
    }
    const body = (await res.json()) as { token: string; expires_at: string };
    return { token: body.token, expiresAt: new Date(body.expires_at).getTime() };
  }
}
