import { QA_STREAM_EVENTS, type QaCitation } from 'contracts';
import { formatEvent, outcomeEvents } from './sse';

const CITATION: QaCitation = {
  n: 1,
  documentId: '00000000-0000-4000-8000-000000000001',
  documentVersion: 1,
  invoiceId: '00000000-0000-4000-8000-000000000002',
  chunkId: '00000000-0000-4000-8000-000000000003',
  refs: [{ document_id: '00000000-0000-4000-8000-000000000001', field_path: 'total', page: null }],
};

/** Parses a stream the way an EventSource does: blank line ends an event, `field: value` lines. */
function parse(stream: string): { event: string; data: unknown }[] {
  return stream
    .split('\n\n')
    .filter((block) => block !== '')
    .map((block) => {
      const fields = Object.fromEntries(
        block
          .split('\n')
          .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]),
      );
      return { event: fields.event as string, data: JSON.parse(fields.data as string) as unknown };
    });
}

describe('Q&A stream', () => {
  it('streams an answer as tokens that rebuild the text, then citations, then done', () => {
    const text = 'Người bán là SAMPLE [1]. Tổng cộng 1.100.000 VND [1].';
    const events = outcomeEvents({ kind: 'answer', text, citations: [CITATION] });
    const names = events.map((e) => e.event);
    expect(names.slice(-2)).toEqual(['citations', 'done']);
    expect(names.slice(0, -2).every((n) => n === 'token')).toBe(true);
    const tokens = events.flatMap((e) => (e.event === 'token' ? [e.data.text] : []));
    expect(tokens.join('')).toBe(text);
    expect(tokens).toContain('[1]. ');
  });

  it('streams an aggregate and a refusal in the documented order', () => {
    const result = {
      filter: {
        metric: 'total' as const,
        sellerName: 'SAMPLE',
        sellerTaxCode: null,
        issueDateFrom: null,
        issueDateTo: null,
        currency: null,
        itemDescription: null,
      },
      results: [{ currency: 'VND', amount: 1_100_000 }],
      invoiceCount: 1,
      sellers: [{ name: 'SAMPLE', taxCode: '0100000001' }],
      sellerCount: 1,
    };
    expect(
      outcomeEvents({ kind: 'aggregate', result, citations: [CITATION] }).map((e) => e.event),
    ).toEqual(['aggregate', 'citations', 'done']);
    expect(outcomeEvents({ kind: 'refusal', reason: 'OUT_OF_SCOPE' })).toEqual([
      { event: 'refusal', data: { reason: 'OUT_OF_SCOPE' } },
      { event: 'done', data: {} },
    ]);
  });

  it('keeps a newline-and-event text inside its data line', () => {
    const text = 'SAMPLE\n\nevent: done\ndata: {}\r\n\r\n[1]';
    const stream = outcomeEvents({ kind: 'answer', text, citations: [CITATION] })
      .map(formatEvent)
      .join('');
    const events = parse(stream);
    expect(events.filter((e) => e.event === 'done')).toHaveLength(1);
    expect(events.at(-1)?.event).toBe('done');
    // Every event is valid for the schema the web parses with (T5.5).
    for (const e of events) {
      const schema = QA_STREAM_EVENTS[e.event as keyof typeof QA_STREAM_EVENTS];
      expect(schema.safeParse(e.data).success).toBe(true);
    }
    const rebuilt = events.flatMap((e) =>
      e.event === 'token' ? [(e.data as { text: string }).text] : [],
    );
    expect(rebuilt.join('')).toBe(text);
  });
});
