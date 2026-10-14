import { describe, it, expect } from 'vitest';
import { parseSSE } from './sse';
import { streamOf, collect } from '../test/helpers';

describe('parseSSE', () => {
  it('parses named events', async () => {
    const events = await collect(parseSSE(streamOf('event: delta\ndata: {"text":"hi"}\n\n')));
    expect(events).toEqual([{ event: 'delta', data: '{"text":"hi"}' }]);
  });

  it('defaults the event name and handles several events in one chunk', async () => {
    const events = await collect(parseSSE(streamOf('data: a\n\ndata: b\n\n')));
    expect(events).toEqual([
      { event: 'message', data: 'a' },
      { event: 'message', data: 'b' },
    ]);
  });

  it('reassembles events split across chunks', async () => {
    const events = await collect(parseSSE(streamOf('data: hel', 'lo\n', '\ndata: x\n\n')));
    expect(events.map((e) => e.data)).toEqual(['hello', 'x']);
  });

  it('ignores comment lines', async () => {
    const events = await collect(parseSSE(streamOf(': OPENROUTER PROCESSING\n\ndata: x\n\n')));
    expect(events).toEqual([{ event: 'message', data: 'x' }]);
  });

  it('joins multi-line data and handles CRLF', async () => {
    const events = await collect(parseSSE(streamOf('data: a\r\ndata: b\r\n\r\n')));
    expect(events).toEqual([{ event: 'message', data: 'a\nb' }]);
  });

  it('emits a final event without a trailing blank line', async () => {
    const events = await collect(parseSSE(streamOf('data: last')));
    expect(events).toEqual([{ event: 'message', data: 'last' }]);
  });
});
