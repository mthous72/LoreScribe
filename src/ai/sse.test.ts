import { describe, it, expect } from 'vitest';
import { SseParser } from './sse';

/**
 * The parser exists for chunk boundaries, so the tests are mostly about where
 * a chunk can end: mid-line, mid-event, between the two newlines that end an
 * event, and between the bytes of a CRLF.
 */

const events = (chunks: string[]) => {
  const p = new SseParser();
  const out = chunks.flatMap((c) => p.feed(c));
  return [...out, ...p.end()];
};

describe('SseParser', () => {
  it('reads one event', () => {
    expect(events(['data: hello\n\n'])).toEqual([{ event: null, id: null, data: 'hello' }]);
  });

  it('gives the same answer however the bytes were cut', () => {
    const whole = 'event: delta\ndata: {"a":1}\ndata: {"b":2}\n\n: keep-alive\n\ndata: [DONE]\n\n';
    const expected = events([whole]);
    expect(expected).toEqual([
      { event: 'delta', id: null, data: '{"a":1}\n{"b":2}' },
      { event: null, id: null, data: '[DONE]' },
    ]);
    for (let cut = 1; cut < whole.length; cut++) {
      expect(events([whole.slice(0, cut), whole.slice(cut)])).toEqual(expected);
    }
  });

  it('accepts either line ending, even split across chunks', () => {
    expect(events(['data: a\r', '\n\r\ndata: b\r\n\r\n']))
      .toEqual([{ event: null, id: null, data: 'a' }, { event: null, id: null, data: 'b' }]);
  });

  it('ignores comments and unknown fields', () => {
    expect(events([': OPENROUTER PROCESSING\n\nretry: 3000\nfoo: bar\ndata: x\n\n']))
      .toEqual([{ event: null, id: null, data: 'x' }]);
  });

  it('keeps a data value that itself contains a colon', () => {
    expect(events(['data: {"t":"12:30"}\n\n'])[0]?.data).toBe('{"t":"12:30"}');
  });

  it('flushes a final event that the stream closed without terminating', () => {
    const p = new SseParser();
    expect(p.feed('data: last')).toEqual([]);
    expect(p.end()).toEqual([{ event: null, id: null, data: 'last' }]);
  });

  it('carries an id', () => {
    expect(events(['id: 7\ndata: x\n\n'])[0]?.id).toBe('7');
  });
});
