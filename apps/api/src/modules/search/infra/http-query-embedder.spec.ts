import { ConfigService } from '@nestjs/config';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Env } from '../../../config/env.schema';
import { QueryEmbeddingUnavailableError } from '../application/query-embedder.port';
import { HttpQueryEmbedder } from './http-query-embedder';

const TOKEN = 'unit-test-token-0123456789';
const QUESTION = 'Hoá đơn SAMPLE mua cà phê';
const unit = () => Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));

describe('HttpQueryEmbedder (real HTTP against a local stub)', () => {
  let server: Server;
  let seen: { headers: IncomingMessage['headers']; body: string; url?: string } | undefined;
  let reply: (res: ServerResponse) => void;

  const embedder = (timeoutMs = 2_000) => {
    const { port } = server.address() as AddressInfo;
    const env: Partial<Env> = {
      AI_SERVICE_URL: `http://127.0.0.1:${port}`,
      AI_SERVICE_TOKEN: TOKEN,
    };
    const e = new HttpQueryEmbedder({ get: (k: keyof Env) => env[k] } as unknown as ConfigService<
      Env,
      true
    >);
    e.timeoutMs = timeoutMs;
    return e;
  };
  const json = (status: number, body: unknown) => (res: ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };
  const failure = async () => {
    const err = await embedder(300)
      .embed(QUESTION)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QueryEmbeddingUnavailableError);
    // Nothing of the question or of the body leaves through the error.
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

  it('posts the question as a query with the service token, returns the vector and its model', async () => {
    reply = json(200, { vectors: [unit()], usage: { model: 'fake-embedding', texts: 1 } });
    const result = await embedder().embed(QUESTION);
    expect(seen?.url).toBe('/embed');
    expect(seen?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(seen?.body ?? '')).toEqual({ texts: [QUESTION], task: 'query' });
    expect(result).toEqual({ model: 'fake-embedding', vector: unit() });
  });

  it.each([
    ['a vector of the wrong length', { vectors: [[1, 0]], usage: { model: 'm' } }],
    ['two vectors for one question', { vectors: [unit(), unit()], usage: { model: 'm' } }],
    ['a vector holding a string', { vectors: [[...unit().slice(1), 'x']], usage: { model: 'm' } }],
    ['no model', { vectors: [unit()], usage: {} }],
  ])('refuses %s', async (_name, body) => {
    reply = json(200, body);
    await failure();
  });

  it('refuses a body that is not JSON', async () => {
    reply = (res) => res.writeHead(200).end('not json SAMPLE');
    await failure();
  });

  it.each([503, 500, 429, 422, 401])('%i is unavailable, its body is not read', async (status) => {
    reply = json(status, { code: 'LLM_RATE_LIMITED', message: QUESTION });
    await failure();
  });

  it('nothing listening is unavailable', async () => {
    const env: Partial<Env> = { AI_SERVICE_URL: 'http://127.0.0.1:9', AI_SERVICE_TOKEN: TOKEN };
    const e = new HttpQueryEmbedder({ get: (k: keyof Env) => env[k] } as unknown as ConfigService<
      Env,
      true
    >);
    await expect(e.embed(QUESTION)).rejects.toBeInstanceOf(QueryEmbeddingUnavailableError);
  });

  it('a timeout is unavailable', async () => {
    reply = () => undefined; // never answers
    await failure();
  });
});
