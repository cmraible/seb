import crypto from 'crypto';

import { describe, it, expect, beforeEach } from 'vitest';

import { TokenMinter } from './token-minter.js';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
const PUB = publicKey.export({ type: 'spki', format: 'pem' }) as string;

function decodePart(s: string): unknown {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'));
}

describe('TokenMinter.signAppJwt', () => {
  it('emits a verifiable RS256 JWT with the App id as iss', () => {
    const minter = new TokenMinter('12345', PEM);
    const jwt = minter.signAppJwt(Date.now());
    const [headerB64, payloadB64, sigB64] = jwt.split('.');
    expect(decodePart(headerB64)).toEqual({ alg: 'RS256', typ: 'JWT' });

    const payload = decodePart(payloadB64) as { iss: string; iat: number; exp: number };
    expect(payload.iss).toBe('12345');
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(10 * 60);

    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${headerB64}.${payloadB64}`);
    const sig = Buffer.from(sigB64.replace(/-/g, '+').replace(/_/g, '/') + '==', 'base64');
    expect(verifier.verify(PUB, sig)).toBe(true);
  });
});

describe('TokenMinter.getInstallationToken', () => {
  let minter: TokenMinter;
  let calls: string[];

  beforeEach(() => {
    calls = [];
    const fakeFetch = (async (url: string, _init?: RequestInit) => {
      calls.push(url);
      return new Response(
        JSON.stringify({ token: `tok_${calls.length}`, expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    minter = new TokenMinter('12345', PEM, fakeFetch);
  });

  it('caches installation tokens until they near expiry', async () => {
    const a = await minter.getInstallationToken(42);
    const b = await minter.getInstallationToken(42);
    expect(a).toBe('tok_1');
    expect(b).toBe('tok_1');
    expect(calls.length).toBe(1);
  });

  it('mints separate tokens for separate installations', async () => {
    await minter.getInstallationToken(1);
    await minter.getInstallationToken(2);
    expect(calls.length).toBe(2);
  });

  it('refreshes when cached token is within the refresh buffer', async () => {
    const shortFetch = (async () => {
      calls.push('mint');
      return new Response(
        JSON.stringify({ token: `tok_${calls.length}`, expires_at: new Date(Date.now() + 60 * 1000).toISOString() }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    const m = new TokenMinter('12345', PEM, shortFetch);
    await m.getInstallationToken(7);
    await m.getInstallationToken(7);
    expect(calls.length).toBe(2);
  });

  it('surfaces GitHub error responses', async () => {
    const errFetch = (async () =>
      new Response('boom', { status: 401, headers: { 'Content-Type': 'text/plain' } })) as typeof fetch;
    const m = new TokenMinter('12345', PEM, errFetch);
    await expect(m.getInstallationToken(99)).rejects.toThrow(/401/);
  });
});

describe('TokenMinter.getInstallationForRepo', () => {
  it('looks up and caches owner/repo → installation id', async () => {
    let lookups = 0;
    const fakeFetch = (async (url: string) => {
      lookups++;
      expect(url).toContain('/repos/foo/bar/installation');
      return new Response(JSON.stringify({ id: 5150 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const m = new TokenMinter('12345', PEM, fakeFetch);
    expect(await m.getInstallationForRepo('foo', 'bar')).toBe(5150);
    expect(await m.getInstallationForRepo('FOO', 'BAR')).toBe(5150);
    expect(lookups).toBe(1);
  });
});
