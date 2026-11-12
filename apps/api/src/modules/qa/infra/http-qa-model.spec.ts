import { ConfigService } from '@nestjs/config';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Env } from '../../../config/env.schema';
import { QaModelUnavailableError } from '../application/qa-model.port';
import { HttpQaModel } from './http-qa-model';

const TOKEN = 'unit-test-token-0123456789';
const QUESTION = 'Tháng 9 chi bao nhiêu cho SAMPLE?';
const FILTER = {
  metric: 'total',
  sellerName: 'SAMPLE',
  sellerTaxCode: null,
  issueDateFrom: '2026-09-01',
  issueDateTo: '2026-09-30',
  currency: null,
  itemDescription: null,
};

describe('HttpQaModel (real HTTP against a local stub)', () => {
  let server: Server;
  let seen: { headers: IncomingMessage['headers']; body: string; url?: string } | undefined;
  let reply: (res: ServerResponse) => void;

  const model = (timeoutMs = 2_000, demo = false) => {
    const { port } = server.address() as AddressInfo;
    const env: Partial<Env> = {
      AI_SERVICE_URL: `http://127.0.0.1:${port}`,
      AI_SERVICE_TOKEN: TOKEN,
      DEMO_READ_ONLY: demo,
    };
    const m = new HttpQaModel({ get: (k: keyof Env) => env[k] } as unknown as ConfigService<
      Env,
      true
    >);
    m.timeoutMs = timeoutMs;
    return m;
  };
  const json = (status: number, body: unknown) => (res: ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };
  const unavailable = async (call: Promise<unknown>) => {
    const err = await call.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QaModelUnavailableError);
    expect((err as Error).message).not.toContain('SAMPLE');
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (c: Buffer) => parts.push(c));
      req.on('end', () => {
        seen = { headers: req.headers, body: Buffer.concat(parts).toString('utf8'), url: req.url };
        reply(res);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('classify posts question and date with the token and returns the validated route', async () => {
    reply = json(200, { output: { intent: 'aggregate', filter: FILTER }, usage: {} });
    const route = await model().classify(QUESTION, '2026-11-11');
    expect(seen?.url).toBe('/classify');
    expect(seen?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(seen?.body ?? '')).toEqual({ question: QUESTION, today: '2026-11-11' });
    expect(route).toEqual({ intent: 'aggregate', filter: FILTER });
  });

  it('answer numbers the sources from 1 in the order given', async () => {
    reply = json(200, { output: { insufficientEvidence: false, answer: 'SAMPLE [2]' }, usage: {} });
    const answer = await model().answer(QUESTION, ['chunk a', 'chunk b']);
    expect(seen?.url).toBe('/answer');
    expect(JSON.parse(seen?.body ?? '')).toEqual({
      question: QUESTION,
      sources: [
        { n: 1, content: 'chunk a' },
        { n: 2, content: 'chunk b' },
      ],
    });
    expect(answer).toEqual({ insufficientEvidence: false, answer: 'SAMPLE [2]' });
  });

  it.each([
    ['null output (the model answered off-schema)', null],
    ['a route with SQL in it', { intent: 'aggregate', filter: { ...FILTER, sql: 'DROP TABLE x' } }],
    ['an unknown metric', { intent: 'aggregate', filter: { ...FILTER, metric: 'max' } }],
    ['an unknown intent', { intent: 'sql', filter: null }],
  ])('turns %s into null, a refusal and not an outage', async (_name, output) => {
    reply = json(200, { output, usage: {} });
    await expect(model().classify(QUESTION, '2026-11-11')).resolves.toBeNull();
  });

  it.each([
    ['503 with a body quoting the question', json(503, { code: 'LLM_RATE_LIMITED', q: QUESTION })],
    ['422 echoing the input', json(422, { detail: [{ input: QUESTION }] })],
    ['not JSON', (res: ServerResponse) => res.writeHead(200).end('SAMPLE')],
    ['no output key', json(200, { usage: {} })],
  ])('throws a bare error on %s', async (_name, r) => {
    reply = r;
    await unavailable(model().classify(QUESTION, '2026-11-11'));
  });

  it('cuts an oversized source to the AI service limit instead of being refused', async () => {
    reply = json(200, { output: { insufficientEvidence: true, answer: '' }, usage: {} });
    await model().answer(QUESTION, ['x'.repeat(25_000)]);
    const sent = JSON.parse(seen?.body ?? '') as { sources: { content: string }[] };
    expect(sent.sources[0]!.content).toHaveLength(20_000);
  });

  it('never calls the AI service on the public demo', async () => {
    seen = undefined;
    reply = json(200, { output: { intent: 'lookup', filter: null }, usage: {} });
    await unavailable(model(2_000, true).classify(QUESTION, '2026-11-11'));
    await unavailable(model(2_000, true).answer(QUESTION, ['x']));
    expect(seen).toBeUndefined();
  });

  it('gives up after its timeout', async () => {
    reply = () => undefined; // never answers
    await unavailable(model(200).answer(QUESTION, ['x']));
  });

  it('stops waiting when the caller cancels', async () => {
    reply = () => undefined;
    const cancel = new AbortController();
    const call = model(10_000).classify(QUESTION, '2026-11-11', cancel.signal);
    setTimeout(() => cancel.abort(), 50);
    const started = Date.now();
    await unavailable(call);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
