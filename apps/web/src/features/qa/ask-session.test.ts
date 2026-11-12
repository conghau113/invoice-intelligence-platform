import type { QaStreamEvent } from 'contracts';
import { describe, expect, it } from 'vitest';
import { AskError } from './ask-client';
import { AskSession } from './ask-session';
import { askReducer, initialAskState, type AskAction, type AskState } from './ask-state';

/** A fake `ask` the test drives by hand: emit events, finish, fail; it records each signal. */
function fakeAsk() {
  const calls: Array<{
    question: string;
    emit: (e: QaStreamEvent) => void;
    signal: AbortSignal;
    resolve: () => void;
    reject: (err: unknown) => void;
  }> = [];
  const ask = (question: string, emit: (e: QaStreamEvent) => void, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      calls.push({ question, emit, signal, resolve, reject });
    });
  return { ask, calls };
}

function setup() {
  let state: AskState = initialAskState;
  const dispatch = (a: AskAction) => {
    state = askReducer(state, a);
  };
  const fake = fakeAsk();
  const session = new AskSession(dispatch, fake.ask);
  return { session, fake, state: () => state };
}

const token = (text: string): QaStreamEvent => ({ event: 'token', data: { text } });
const done: QaStreamEvent = { event: 'done', data: {} };

describe('AskSession', () => {
  it('a second question aborts the first; nothing of the first reaches the second', async () => {
    const { session, fake, state } = setup();
    const first = session.submit('one');
    fake.calls[0]!.emit(token('first '));
    const second = session.submit('two');
    expect(fake.calls[0]!.signal.aborted).toBe(true);
    expect(fake.calls[1]!.signal.aborted).toBe(false);

    // The first one still produces a late event and then fails because of its abort.
    fake.calls[0]!.emit(token('late'));
    fake.calls[0]!.reject(new DOMException('aborted', 'AbortError'));
    await first;
    expect(state()).toMatchObject({ phase: 'waiting', question: 'two', text: '', failure: null });

    fake.calls[1]!.emit(token('second'));
    fake.calls[1]!.emit(done);
    fake.calls[1]!.resolve();
    await second;
    expect(state()).toMatchObject({ phase: 'done', question: 'two', text: 'second' });
  });

  it('stop aborts, keeps what arrived, and a late event or error changes nothing', async () => {
    const { session, fake, state } = setup();
    const p = session.submit('q');
    fake.calls[0]!.emit(token('part'));
    session.stop();
    expect(fake.calls[0]!.signal.aborted).toBe(true);
    fake.calls[0]!.emit(token(' more'));
    fake.calls[0]!.reject(new AskError({ kind: 'stream' }));
    await p;
    expect(state()).toMatchObject({ phase: 'cancelled', text: 'part', failure: null });
    session.stop(); // nothing in flight: no second "cancelled"
    expect(state().phase).toBe('cancelled');
  });

  it('a failure that is not an abort is reported with its reason', async () => {
    const { session, fake, state } = setup();
    const p = session.submit('q');
    fake.calls[0]!.reject(
      new AskError({ kind: 'http', status: 503, code: 'AI_SERVICE_UNAVAILABLE' }),
    );
    await p;
    expect(state()).toMatchObject({
      phase: 'failed',
      failure: { kind: 'http', status: 503, code: 'AI_SERVICE_UNAVAILABLE' },
    });
    const q = session.submit('again');
    fake.calls[1]!.reject(new Error('boom'));
    await q;
    expect(state().failure).toEqual({ kind: 'network' });
  });

  it('dispose (unmount) aborts the question in flight without reporting anything', async () => {
    const { session, fake, state } = setup();
    const p = session.submit('q');
    session.dispose();
    expect(fake.calls[0]!.signal.aborted).toBe(true);
    fake.calls[0]!.reject(new DOMException('aborted', 'AbortError'));
    await p;
    expect(state().phase).toBe('waiting'); // nobody is looking any more
  });

  it('the first question settling late does not stop the second from being stoppable', async () => {
    const { session, fake, state } = setup();
    const first = session.submit('one');
    session.submit('two');
    fake.calls[0]!.reject(new DOMException('aborted', 'AbortError'));
    await first;
    session.stop();
    expect(fake.calls[1]!.signal.aborted).toBe(true);
    expect(state()).toMatchObject({ phase: 'cancelled', question: 'two' });
  });
});
