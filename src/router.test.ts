import { describe, it, expect } from 'vitest';

import {
  escapeXml,
  formatMessages,
  stripInternalTags,
  formatOutbound,
  findChannel,
} from './router.js';
import { Channel, NewMessage } from './types.js';

// --- escapeXml ---

describe('escapeXml', () => {
  it('escapes ampersands, angle brackets, and quotes', () => {
    expect(escapeXml('a & b < c > d "e"')).toBe(
      'a &amp; b &lt; c &gt; d &quot;e&quot;',
    );
  });

  it('returns empty string for empty input', () => {
    expect(escapeXml('')).toBe('');
  });

  it('passes through strings with no special characters', () => {
    expect(escapeXml('hello world')).toBe('hello world');
  });

  it('handles multiple consecutive special characters', () => {
    expect(escapeXml('<<>>')).toBe('&lt;&lt;&gt;&gt;');
  });
});

// --- stripInternalTags ---

describe('stripInternalTags', () => {
  it('strips a single internal tag', () => {
    expect(stripInternalTags('<internal>secret</internal> visible')).toBe(
      'visible',
    );
  });

  it('strips multiple internal tags', () => {
    expect(
      stripInternalTags(
        '<internal>a</internal> hello <internal>b</internal> world',
      ),
    ).toBe('hello world');
  });

  it('strips multiline internal tags', () => {
    expect(
      stripInternalTags('<internal>\nline1\nline2\n</internal> result'),
    ).toBe('result');
  });

  it('collapses extra whitespace after stripping', () => {
    expect(stripInternalTags('before  <internal>x</internal>  after')).toBe(
      'before after',
    );
  });

  it('returns empty string when everything is internal', () => {
    expect(stripInternalTags('<internal>all hidden</internal>')).toBe('');
  });

  it('returns input unchanged when no internal tags', () => {
    expect(stripInternalTags('just plain text')).toBe('just plain text');
  });
});

// --- formatOutbound ---

describe('formatOutbound', () => {
  it('strips internal tags and returns visible text', () => {
    expect(formatOutbound('<internal>hidden</internal> Hi there')).toBe(
      'Hi there',
    );
  });

  it('returns empty string when result is empty after stripping', () => {
    expect(formatOutbound('<internal>all gone</internal>')).toBe('');
  });

  it('returns plain text as-is', () => {
    expect(formatOutbound('hello')).toBe('hello');
  });
});

// --- formatMessages ---

describe('formatMessages', () => {
  const tz = 'UTC';

  it('formats a single message with XML envelope', () => {
    const msgs: NewMessage[] = [
      {
        id: '1',
        chat_jid: 'test@g.us',
        sender: 'user1',
        sender_name: 'Alice',
        content: 'Hello',
        timestamp: '2026-01-15T12:00:00.000Z',
      },
    ];
    const result = formatMessages(msgs, tz);
    expect(result).toContain('<context timezone="UTC" />');
    expect(result).toContain('<messages>');
    expect(result).toContain('sender="Alice"');
    expect(result).toContain('>Hello</message>');
  });

  it('escapes special characters in sender names and content', () => {
    const msgs: NewMessage[] = [
      {
        id: '2',
        chat_jid: 'test@g.us',
        sender: 'user2',
        sender_name: 'Bob & "Friends"',
        content: 'x < y > z',
        timestamp: '2026-01-15T12:00:00.000Z',
      },
    ];
    const result = formatMessages(msgs, tz);
    expect(result).toContain('sender="Bob &amp; &quot;Friends&quot;"');
    expect(result).toContain('>x &lt; y &gt; z</message>');
  });

  it('formats multiple messages separated by newlines', () => {
    const msgs: NewMessage[] = [
      {
        id: '1',
        chat_jid: 'test@g.us',
        sender: 'a',
        sender_name: 'A',
        content: 'first',
        timestamp: '2026-01-15T12:00:00.000Z',
      },
      {
        id: '2',
        chat_jid: 'test@g.us',
        sender: 'b',
        sender_name: 'B',
        content: 'second',
        timestamp: '2026-01-15T12:01:00.000Z',
      },
    ];
    const result = formatMessages(msgs, tz);
    const lines = result.split('\n');
    // header, <messages>, msg1, msg2, </messages>
    expect(lines).toHaveLength(5);
  });
});

// --- findChannel ---

describe('findChannel', () => {
  function fakeChannel(name: string, prefix: string): Channel {
    return {
      name,
      ownsJid: (jid: string) => jid.startsWith(prefix),
      connect: async () => {},
      sendMessage: async () => {},
      isConnected: () => true,
      disconnect: async () => {},
    };
  }

  it('returns the channel that owns the JID', () => {
    const wa = fakeChannel('whatsapp', 'wa:');
    const tg = fakeChannel('telegram', 'tg:');
    expect(findChannel([wa, tg], 'tg:123')).toBe(tg);
  });

  it('returns undefined when no channel matches', () => {
    const wa = fakeChannel('whatsapp', 'wa:');
    expect(findChannel([wa], 'gh:456')).toBeUndefined();
  });

  it('returns the first matching channel', () => {
    const ch1 = fakeChannel('first', 'x:');
    const ch2 = fakeChannel('second', 'x:');
    expect(findChannel([ch1, ch2], 'x:1')).toBe(ch1);
  });
});
