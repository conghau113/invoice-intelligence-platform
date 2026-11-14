import { QA_STREAM_EVENTS } from 'contracts';

export type SseEvent = { event: string; data: unknown };

/**
 * Parses `text/event-stream` like an EventSource, and checks each event against the contract.
 * Shared by the Q&A integration test (T5.4) and the RAG evaluation harness (T5.6).
 */
export function parseSse(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const lines = block.split('\n');
      const event = lines.find((l) => l.startsWith('event: '))!.slice('event: '.length);
      const data = JSON.parse(
        lines.find((l) => l.startsWith('data: '))!.slice('data: '.length),
      ) as unknown;
      const parsed = QA_STREAM_EVENTS[event as keyof typeof QA_STREAM_EVENTS].safeParse(data);
      if (!parsed.success) throw new Error(`event ${event} does not match the contract`);
      return { event, data };
    });
}
