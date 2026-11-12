import type { QaStreamEvent } from 'contracts';
import { describe, expect, it } from 'vitest';
import { askReducer, initialAskState, type AskAction, type AskState } from './ask-state';

const run = (actions: AskAction[], from: AskState = initialAskState) =>
  actions.reduce(askReducer, from);
const ev = (event: QaStreamEvent): AskAction => ({ type: 'event', event });
const start: AskAction = { type: 'start', question: 'Ai bán mực?' };

describe('askReducer', () => {
  it('waits, then grows the text token by token, then is done with its citations', () => {
    const waiting = run([start]);
    expect(waiting.phase).toBe('waiting');
    const s = run([ev({ event: 'token', data: { text: 'Ink ' } })], waiting);
    expect(s).toMatchObject({ phase: 'streaming', text: 'Ink ', citations: null });
    const end = run(
      [
        ev({ event: 'token', data: { text: '[1]' } }),
        ev({ event: 'citations', data: { citations: [] } }),
        ev({ event: 'done', data: {} }),
      ],
      s,
    );
    expect(end).toMatchObject({ phase: 'done', text: 'Ink [1]', citations: [] });
  });

  it('a refusal ends as refused with its reason', () => {
    const s = run([
      start,
      ev({ event: 'refusal', data: { reason: 'OUT_OF_SCOPE' } }),
      ev({ event: 'done', data: {} }),
    ]);
    expect(s).toMatchObject({ phase: 'refused', refusal: 'OUT_OF_SCOPE', text: '' });
  });

  it('a stop keeps what arrived, and later events cannot bring the answer back', () => {
    const s = run([
      start,
      ev({ event: 'token', data: { text: 'Ink ' } }),
      { type: 'cancel' },
      ev({ event: 'token', data: { text: 'more' } }),
      ev({ event: 'done', data: {} }),
    ]);
    expect(s).toMatchObject({ phase: 'cancelled', text: 'Ink ' });
  });

  it('a failure is kept with its reason; stop and fail do nothing once finished', () => {
    const failed = run([start, { type: 'fail', failure: { kind: 'network' } }]);
    expect(failed).toMatchObject({ phase: 'failed', failure: { kind: 'network' } });
    const done = run([start, ev({ event: 'done', data: {} })]);
    expect(run([{ type: 'cancel' }, { type: 'fail', failure: { kind: 'stream' } }], done)).toBe(
      done,
    );
  });

  it('a new question starts from nothing', () => {
    const s = run([start, ev({ event: 'token', data: { text: 'old' } }), start]);
    expect(s).toEqual({ ...initialAskState, phase: 'waiting', question: 'Ai bán mực?' });
  });
});
