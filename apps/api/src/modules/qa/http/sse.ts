import type { QaStreamEvent } from 'contracts';
import type { QaOutcome } from '../application/qa.service';

/**
 * One Server-Sent Event. `data` is JSON on a single line: JSON.stringify escapes CR and LF, so an
 * answer or an invoice name containing "\n\nevent: done" stays inside its string and cannot end the
 * event or start another one.
 */
export function formatEvent(e: QaStreamEvent): string {
  return `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
}

/** Words with their trailing space; a citation marker like "[2]" has no space, so it stays whole. */
const PIECE = /\S+\s*|\s+/g;

/**
 * The events of an outcome, in the order API.md documents. The answer was checked in full before
 * this runs (T5.4: verify first, then stream), so the web never has to take back a token.
 */
export function outcomeEvents(outcome: QaOutcome): QaStreamEvent[] {
  switch (outcome.kind) {
    case 'refusal':
      return [
        { event: 'refusal', data: { reason: outcome.reason } },
        { event: 'done', data: {} },
      ];
    case 'aggregate':
      return [
        { event: 'aggregate', data: outcome.result },
        { event: 'citations', data: { citations: outcome.citations } },
        { event: 'done', data: {} },
      ];
    case 'answer':
      return [
        ...(outcome.text.match(PIECE) ?? []).map((text): QaStreamEvent => ({
          event: 'token',
          data: { text },
        })),
        { event: 'citations', data: { citations: outcome.citations } },
        { event: 'done', data: {} },
      ];
  }
}
