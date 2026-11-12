import type { QaStreamEvent } from 'contracts';
import { ask as askOverHttp, AskError } from './ask-client';
import type { AskAction } from './ask-state';

type Ask = (
  question: string,
  onEvent: (event: QaStreamEvent) => void,
  signal: AbortSignal,
) => Promise<void>;

/**
 * One question at a time, outside React so it can be tested without a DOM (`useAsk` wraps it).
 *
 * - Asking again aborts the question in flight: its events and its error never reach the new one.
 * - Stop aborts it and says so; what had arrived stays (the reducer marks it unfinished).
 * - Dispose (unmount) aborts it silently.
 * Aborting closes the connection, so the BFF and then the API stop waiting on the model.
 */
export class AskSession {
  private current: AbortController | null = null;

  constructor(
    private readonly dispatch: (action: AskAction) => void,
    private readonly ask: Ask = askOverHttp,
  ) {}

  submit(question: string): Promise<void> {
    this.current?.abort();
    const controller = new AbortController();
    this.current = controller;
    this.dispatch({ type: 'start', question });
    const onEvent = (event: QaStreamEvent) => {
      // Belt and braces: the client stops reading on abort, but nothing late may slip through.
      if (!controller.signal.aborted) this.dispatch({ type: 'event', event });
    };
    return this.ask(question, onEvent, controller.signal)
      .catch((err: unknown) => {
        if (controller.signal.aborted) return; // replaced, stopped or unmounted: already handled
        this.dispatch({
          type: 'fail',
          failure: err instanceof AskError ? err.failure : { kind: 'network' },
        });
      })
      .finally(() => {
        if (this.current === controller) this.current = null;
      });
  }

  stop(): void {
    if (this.current === null) return;
    this.current.abort();
    this.current = null;
    this.dispatch({ type: 'cancel' });
  }

  dispose(): void {
    this.current?.abort();
    this.current = null;
  }
}
