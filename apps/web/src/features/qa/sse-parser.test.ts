import { describe, expect, it } from 'vitest';
import { SSE_MAX_EVENT_CHARS, SseLimitError, SseParser } from './sse-parser';

const STREAM = 'event: token\ndata: {"text":"Hello "}\n\nevent: done\ndata: {}\n\n';

describe('SseParser', () => {
  it('reads named events with their data', () => {
    expect(new SseParser().push(STREAM)).toEqual([
      { event: 'token', data: '{"text":"Hello "}' },
      { event: 'done', data: '{}' },
    ]);
  });

  it('gives the same events whatever the pieces the text arrives in, one character at a time too', () => {
    const p = new SseParser();
    const events = [...STREAM].flatMap((c) => p.push(c));
    expect(events).toEqual(new SseParser().push(STREAM));
  });

  it('accepts CR and CRLF line ends, also when CR and LF arrive in different pieces', () => {
    const p = new SseParser();
    const events = [
      ...p.push('event: a\r'),
      ...p.push('\ndata: 1\r'),
      ...p.push('\n\r'),
      ...p.push('\nevent: b\rdata: 2\r\r'),
    ];
    expect(events).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
    ]);
  });

  it('skips comments, joins several data lines, and keeps colons inside the value', () => {
    const events = new SseParser().push(': ping\n\ndata: a:b\ndata:c\n\n');
    expect(events).toEqual([{ event: 'message', data: 'a:b\nc' }]);
  });

  it('drops an event with no data and keeps an unfinished event until its blank line', () => {
    const p = new SseParser();
    expect(p.push('event: lonely\n\nevent: x\ndata: 1\n')).toEqual([]);
    expect(p.push('\n')).toEqual([{ event: 'x', data: '1' }]);
  });

  it('refuses a line or an event longer than the limit, whatever the pieces it comes in', () => {
    const line = new SseParser();
    const piece = 'x'.repeat(64 * 1024);
    expect(() => {
      for (let sent = 0; sent <= SSE_MAX_EVENT_CHARS; sent += piece.length) line.push(piece);
    }).toThrow(SseLimitError);

    const event = new SseParser();
    const dataLine = `data: ${'y'.repeat(64 * 1024)}\n`;
    expect(() => {
      for (let sent = 0; sent <= SSE_MAX_EVENT_CHARS; sent += dataLine.length) event.push(dataLine);
    }).toThrow(SseLimitError);
  });

  it('a limit counts per event: many normal events in a row are fine', () => {
    const p = new SseParser();
    const one = `data: ${'z'.repeat(64 * 1024)}\n\n`;
    let events = 0;
    for (let i = 0; i < 40; i++) events += p.push(one).length;
    expect(events).toBe(40);
  });

  it('an empty piece between CR and LF does not split the line ending; a leading BOM is dropped', () => {
    const p = new SseParser();
    // Read as two line ends, the LF would be a blank line and end the event after "1".
    const events = [...p.push('\uFEFFdata: 1\r'), ...p.push(''), ...p.push('\ndata: 2\n\n')];
    expect(events).toEqual([{ event: 'message', data: '1\n2' }]);
  });
});
