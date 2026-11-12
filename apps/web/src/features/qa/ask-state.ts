import type { QaAggregateResult, QaCitation, QaRefusalReason, QaStreamEvent } from 'contracts';
import type { AskFailure } from './ask-client';

/**
 * What the Q&A screen shows for the current question.
 * - `waiting`: asked, nothing back yet. The API decides the whole answer before it writes the first
 *   event (T5.4: verify first, then stream), so this can last tens of seconds.
 * - `streaming`: events are arriving; the text grows token by token.
 * - `done`, `refused`: the stream ended with `done`.
 * - `failed`, `cancelled`: the stream did not finish. What had arrived is kept but marked unfinished.
 */
export type AskPhase =
  'idle' | 'waiting' | 'streaming' | 'done' | 'refused' | 'failed' | 'cancelled';

export interface AskState {
  phase: AskPhase;
  /** The question this state is about, as the person sent it. */
  question: string;
  /** Lookup answer text with its `[n]` markers, joined from the `token` events. */
  text: string;
  aggregate: QaAggregateResult | null;
  /** null until the `citations` event: before it, a marker cannot be opened yet. */
  citations: QaCitation[] | null;
  refusal: QaRefusalReason | null;
  failure: AskFailure | null;
}

export type AskAction =
  | { type: 'start'; question: string }
  | { type: 'event'; event: QaStreamEvent }
  | { type: 'fail'; failure: AskFailure }
  | { type: 'cancel' };

export const initialAskState: AskState = {
  phase: 'idle',
  question: '',
  text: '',
  aggregate: null,
  citations: null,
  refusal: null,
  failure: null,
};

const running = (phase: AskPhase) => phase === 'waiting' || phase === 'streaming';

export function askReducer(state: AskState, action: AskAction): AskState {
  switch (action.type) {
    case 'start':
      return { ...initialAskState, phase: 'waiting', question: action.question };
    case 'fail':
      return running(state.phase) ? { ...state, phase: 'failed', failure: action.failure } : state;
    case 'cancel':
      return running(state.phase) ? { ...state, phase: 'cancelled' } : state;
    case 'event':
      // A late event after a stop or a failure must not bring the answer back to life.
      return running(state.phase) ? onEvent(state, action.event) : state;
  }
}

function onEvent(state: AskState, e: QaStreamEvent): AskState {
  switch (e.event) {
    case 'token':
      return { ...state, phase: 'streaming', text: state.text + e.data.text };
    case 'aggregate':
      return { ...state, phase: 'streaming', aggregate: e.data };
    case 'citations':
      return { ...state, phase: 'streaming', citations: e.data.citations };
    case 'refusal':
      return { ...state, phase: 'streaming', refusal: e.data.reason };
    case 'done':
      return { ...state, phase: state.refusal === null ? 'done' : 'refused' };
  }
}
