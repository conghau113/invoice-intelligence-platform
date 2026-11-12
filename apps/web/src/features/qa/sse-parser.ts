/** One Server-Sent Event as received: its name (`message` when the stream gave none) and data. */
export interface RawSseEvent {
  event: string;
  data: string;
}

/**
 * Incremental Server-Sent Events parser (WHATWG HTML, "event stream interpretation"), for a stream
 * read with `fetch`: `EventSource` cannot POST, and the question must not travel in a URL (T5.4).
 *
 * Text arrives in arbitrary pieces, so a line may be split anywhere, even between CR and LF; the
 * unfinished tail is kept until the next piece. Lines end with LF, CR or CRLF. A blank line ends an
 * event; `:` starts a comment; several `data` lines are joined with LF; `id` and `retry` are ignored
 * (nothing reconnects here). An event without data is dropped, as the spec says.
 */
/**
 * The longest line or event accepted, in characters. The largest real event is `citations` with 50
 * aggregate sources (well under 200 KB); past this the stream is broken or hostile, not slow.
 */
export const SSE_MAX_EVENT_CHARS = 1024 * 1024;

/** The stream broke a limit: the reader should stop and report a broken stream. */
export class SseLimitError extends Error {
  constructor() {
    super('server-sent event too large');
  }
}

export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private dataChars = 0;
  /** The last piece ended with CR: an LF at the start of the next one belongs to it. */
  private pendingCr = false;
  /** Nothing read yet: a byte order mark at the very start is dropped (WHATWG). */
  private atStart = true;

  /** Feeds decoded text; returns the events it completed. */
  push(text: string): RawSseEvent[] {
    // An empty piece carries nothing, and must not clear the pending CR either.
    if (text === '') return [];
    let chunk = text;
    if (this.atStart && chunk.startsWith('\uFEFF')) chunk = chunk.slice(1);
    this.atStart = false;
    if (this.pendingCr && chunk.startsWith('\n')) chunk = chunk.slice(1);
    this.pendingCr = false;
    // The kept tail has no line break (it was scanned last time): scan only what is new, so a long
    // line arriving in many pieces costs linear time, not quadratic.
    let i = this.buffer.length;
    this.buffer += chunk;

    const out: RawSseEvent[] = [];
    let start = 0;
    for (; i < this.buffer.length; i++) {
      const c = this.buffer[i];
      if (c !== '\n' && c !== '\r') continue;
      this.line(this.buffer.slice(start, i), out);
      if (c === '\r') {
        if (i + 1 === this.buffer.length) this.pendingCr = true;
        else if (this.buffer[i + 1] === '\n') i++;
      }
      start = i + 1;
    }
    this.buffer = this.buffer.slice(start);
    if (this.buffer.length > SSE_MAX_EVENT_CHARS) throw new SseLimitError();
    return out;
  }

  private line(line: string, out: RawSseEvent[]): void {
    if (line === '') {
      if (this.data.length > 0)
        out.push({ event: this.event || 'message', data: this.data.join('\n') });
      this.event = '';
      this.data = [];
      this.dataChars = 0;
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') {
      this.dataChars += value.length + 1;
      if (this.dataChars > SSE_MAX_EVENT_CHARS) throw new SseLimitError();
      this.data.push(value);
    }
  }
}
