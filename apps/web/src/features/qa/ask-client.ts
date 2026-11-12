import {
  isHttpErrorCode,
  QA_STREAM_EVENTS,
  type HttpErrorCode,
  type QaStreamEvent,
} from 'contracts';
import { SseLimitError, SseParser, type RawSseEvent } from './sse-parser';

/**
 * The most text one answer may stream. A lookup answer is at most 4,000 characters (contracts
 * `QA_MAX_ANSWER_CHARS`), so even with its citations this is far above any real answer.
 */
export const QA_MAX_STREAM_CHARS = 4 * 1024 * 1024;

/** Why asking failed, for the screen to translate. Never carries the question or the answer. */
export type AskFailure =
  /** The request was answered with an error status (`code` when the body named a listed one). */
  | { kind: 'http'; status: number; code: HttpErrorCode | undefined }
  /** No answer at all: the network or the web server is down. */
  | { kind: 'network' }
  /** An event that does not match the contract, or the stream ended before `done`. */
  | { kind: 'stream' };

export class AskError extends Error {
  constructor(readonly failure: AskFailure) {
    super(`ask failed: ${failure.kind}`);
  }
}

/** Checks one raw event against `QA_STREAM_EVENTS`; null when the name or the data is wrong. */
export function toStreamEvent(raw: RawSseEvent): QaStreamEvent | null {
  if (!Object.hasOwn(QA_STREAM_EVENTS, raw.event)) return null;
  const name = raw.event as keyof typeof QA_STREAM_EVENTS;
  let json: unknown;
  try {
    json = JSON.parse(raw.data);
  } catch {
    return null;
  }
  const parsed = QA_STREAM_EVENTS[name].safeParse(json);
  return parsed.success ? ({ event: name, data: parsed.data } as QaStreamEvent) : null;
}

/**
 * Asks the BFF (`POST /api/qa/ask`) and calls `onEvent` for every event, in order, as it arrives.
 * Resolves after `done`. Every event is validated with the contract schema before the screen sees
 * it: the stream is data from the server, and part of it was written by a model.
 *
 * Aborting `signal` stops reading and closes the connection; the BFF passes that on to the API,
 * which stops waiting on the model. The returned promise then rejects with the abort's reason.
 */
export async function ask(
  question: string,
  onEvent: (event: QaStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/qa/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ question }),
      signal,
      cache: 'no-store',
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new AskError({ kind: 'network' });
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: unknown };
    throw new AskError({
      kind: 'http',
      status: res.status,
      code: isHttpErrorCode(body.code) ? body.code : undefined,
    });
  }
  if (res.body === null || !res.headers.get('content-type')?.startsWith('text/event-stream')) {
    throw new AskError({ kind: 'stream' });
  }

  if (signal.aborted) throw signal.reason; // stopped while the headers were on their way
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const parser = new SseParser();
  let received = 0;
  // Do not rely on fetch erroring the body on abort: cancel the read ourselves, so a stop always
  // ends the loop below at once.
  const onAbort = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > QA_MAX_STREAM_CHARS) throw new AskError({ kind: 'stream' });
      let events: RawSseEvent[];
      try {
        events = parser.push(value);
      } catch (err) {
        if (err instanceof SseLimitError) throw new AskError({ kind: 'stream' });
        throw err;
      }
      for (const raw of events) {
        const event = toStreamEvent(raw);
        if (event === null) throw new AskError({ kind: 'stream' });
        onEvent(event);
        if (event.event === 'done') return;
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    // Stop the download too when we leave early (bad event, `done`, abort).
    reader.cancel().catch(() => undefined);
  }
  if (signal.aborted) throw signal.reason;
  // The connection closed before `done`: whatever arrived may be incomplete.
  throw new AskError({ kind: 'stream' });
}
