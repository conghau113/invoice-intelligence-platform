import { ConfigService } from '@nestjs/config';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Env } from '../../../config/env.schema';
import { PermanentIndexError } from '../domain/index-job';
import { HttpAiIndexer, INDEX_REQUEST_REJECTED, INDEX_RESPONSE_INVALID } from './http-ai-indexer';

const TOKEN = 'unit-test-token-0123456789';
const IDS = {
  id: '11111111-1111-4111-8111-111111111111',
  tenant_id: '22222222-2222-4222-8222-222222222222',
  document_id: '33333333-3333-4333-8333-333333333333',
};
const ROW = { ...IDS, document_version: 1, data: { invoiceNo: 'SAMPLE' } };

function answer(embedding: unknown = Array.from({ length: 768 }, () => 0.01)) {
  return {
    model: 'fake-embedding',
    chunks: [
      {
        chunk: {
          tenant_id: IDS.tenant_id,
          document_id: IDS.document_id,
          document_version: 1,
          invoice_id: IDS.id,
          kind: 'header',
          ordinal: 0,
          content: 'Hoá đơn SAMPLE',
          refs: [{ document_id: IDS.document_id, field_path: 'invoiceNo', page: null }],
        },
        embedding,
      },
    ],
  };
}

describe('HttpAiIndexer (real HTTP against a local stub)', () => {
  let server: Server;
  let seen: { headers: IncomingMessage['headers']; body: string; url?: string } | undefined;
  let reply: (res: ServerResponse) => void;

  const indexer = () => {
    const { port } = server.address() as AddressInfo;
    const env: Partial<Env> = {
      AI_SERVICE_URL: `http://127.0.0.1:${port}`,
      AI_SERVICE_TOKEN: TOKEN,
      AI_LLM_TIMEOUT_MS: 2_000,
    };
    return new HttpAiIndexer({ get: (k: keyof Env) => env[k] } as unknown as ConfigService<
      Env,
      true
    >);
  };
  const json = (status: number, body: unknown) => (res: ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
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

  it('posts the row as JSON with the service token and returns the parsed answer', async () => {
    reply = json(200, answer());
    const result = await indexer().index(ROW);
    expect(seen?.url).toBe('/index');
    expect(seen?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(seen?.body ?? '')).toEqual(ROW);
    expect(result.chunks[0]?.embedding).toHaveLength(768);
  });

  it.each([
    ['a vector of the wrong length', answer(Array.from({ length: 767 }, () => 0))],
    ['a vector holding a string', answer([...Array.from({ length: 767 }, () => 0), 'x'])],
    ['no chunk at all', { model: 'm', chunks: [] }],
    ['an unknown field', { ...answer(), extra: 1 }],
  ])('refuses %s, without echoing it', async (_name, body) => {
    reply = json(200, body);
    const err = await indexer()
      .index(ROW)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentIndexError);
    expect((err as PermanentIndexError).code).toBe(INDEX_RESPONSE_INVALID);
    expect((err as Error).message).not.toContain('SAMPLE');
  });

  it('refuses a body that is not JSON', async () => {
    reply = (res) => res.writeHead(200).end('not json SAMPLE');
    await expect(indexer().index(ROW)).rejects.toMatchObject({ code: INDEX_RESPONSE_INVALID });
  });

  it('a 422 (the service refused the row) is permanent', async () => {
    reply = json(422, { detail: 'SAMPLE' });
    const err = await indexer()
      .index(ROW)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentIndexError);
    expect((err as PermanentIndexError).code).toBe(INDEX_REQUEST_REJECTED);
  });

  it.each([503, 500, 429, 408, 401, 404])('%i is transient (not permanent)', async (status) => {
    reply = json(status, { code: 'LLM_RATE_LIMITED' });
    const err = await indexer()
      .index(ROW)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentIndexError);
  });

  it('a 200 whose body is cut off while it is read is transient', async () => {
    reply = (res) => {
      // Promise more bytes than are sent, then drop the connection.
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100000' });
      res.write('{"model": "SAMPLE", "chunks": [');
      setTimeout(() => res.destroy(), 20);
    };
    const err = await indexer()
      .index(ROW)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentIndexError);
  });

  it('a timeout is transient', async () => {
    reply = () => undefined; // never answers
    const err = await indexer()
      .index(ROW)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentIndexError);
  }, 10_000);
});
