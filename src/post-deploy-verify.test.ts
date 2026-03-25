import { describe, expect, it } from 'vitest';

import { buildVerifyPrompt } from './index.js';

describe('buildVerifyPrompt', () => {
  it('includes commit info when provided', () => {
    const prompt = buildVerifyPrompt('abc1234 feat: add feature');
    expect(prompt).toContain('`abc1234 feat: add feature`');
    expect(prompt).toContain('post-deploy verification');
    expect(prompt).toContain('Health endpoint');
    expect(prompt).toContain('curl');
  });

  it('handles missing commit info gracefully', () => {
    const prompt = buildVerifyPrompt('');
    expect(prompt).toContain('commit info is unknown');
    expect(prompt).not.toContain('The deployed commit is');
  });

  it('includes all verification steps', () => {
    const prompt = buildVerifyPrompt('abc1234 test');
    expect(prompt).toContain('Health endpoint');
    expect(prompt).toContain('Process check');
    expect(prompt).toContain('Git verification');
    expect(prompt).toContain('Webhook endpoints');
  });

  it('includes success and failure reporting instructions', () => {
    const prompt = buildVerifyPrompt('abc1234 test');
    expect(prompt).toContain('Deploy verified');
    expect(prompt).toContain('describe what failed');
  });
});
