import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Env } from '../../../config/env.schema';
import {
  PermanentExtractionError,
  TransientExtractionError,
} from '../../queue/domain/extraction-job';
import { HttpAiExtractor } from './http-ai-extractor';

const TOKEN = 'unit-test-token-0123456789';
const TRACE = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const INVOICE: unknown = JSON.parse(
  readFileSync(
    path.join(__dirname, '../../../../../../packages/contracts/fixtures/invoice.valid.json'),
    'utf8',
  ),
);

interface Seen {
  headers: IncomingMessage['headers'];
  body: string;
  url: string | undefined;
}

describe('HttpAiExtractor (real HTTP against a local stub)', () => {
  let server: Server;
  let seen: Seen | undefined;
  let reply: (res: import('node:http').ServerResponse) => void;

  const extractor = (extra: Partial<Env> = {}) => {
    const { port } = server.address() as AddressInfo;
    const env: Partial<Env> = {
      AI_SERVICE_URL: `http://127.0.0.1:${port}`,
      AI_SERVICE_TOKEN: TOKEN,
      ...extra,
    };
    return new HttpAiExtractor({ get: (k: keyof Env) => env[k] } as unknown as ConfigService<
      Env,
      true
    >);
  };
  const input = { bytes: Buffer.from('<xml>SAMPLE</xml>'), sourceType: 'xml' as const };
  const json = (status: number, body: unknown) => (res: import('node:http').ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen = {
          headers: req.headers,
          body: Buffer.concat(chunks).toString('latin1'),
          url: req.url,
        };
        reply(res);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    seen = undefined;
  });

  it('accepts the LLM usage block, including the prompt version stored with every extraction', async () => {
    const usage = {
      model: 'gemini-2.5-flash',
      promptVersion: 'invoice_extraction/v1',
      inputTokens: 1000,
      outputTokens: 150,
      latencyMs: 2400,
      costUsd: 0.000675,
    };
    reply = json(200, { invoice: INVOICE, warnings: [], usage });
    expect((await extractor().extract(input)).usage).toEqual(usage);
  });

  it('rejects a usage block without a prompt version (eval results would not be comparable)', async () => {
    reply = json(200, {
      invoice: INVOICE,
      warnings: [],
      usage: { model: 'm', inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0 },
    });
    await expect(extractor().extract(input)).rejects.toBeInstanceOf(PermanentExtractionError);
  });

  it('sends the file, sourceType, bearer token and traceparent, and returns the validated answer', async () => {
    reply = json(200, { invoice: INVOICE, warnings: [], usage: null });
    const out = await extractor().extract({ ...input, traceparent: TRACE });
    expect(out.usage).toBeNull();
    expect(seen?.url).toBe('/extract');
    expect(seen?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen?.headers.traceparent).toBe(TRACE);
    expect(seen?.headers['content-type']).toMatch(/^multipart\/form-data/);
    expect(seen?.body).toContain('<xml>SAMPLE</xml>');
    expect(seen?.body).toContain('name="sourceType"');
    expect(seen?.body).toContain('filename="document"');
  });

  it('omits traceparent when the job has none', async () => {
    reply = json(200, { invoice: INVOICE, warnings: [], usage: null });
    await extractor().extract(input);
    expect(seen?.headers.traceparent).toBeUndefined();
  });

  it.each([
    [422, 'XML_MALFORMED'],
    [413, 'FILE_TOO_LARGE'],
    [501, 'EXTRACTION_PATH_NOT_IMPLEMENTED'],
  ])('a %i answer with a code is permanent and keeps the code', async (status, code) => {
    reply = json(status, { code, message: 'text that may contain document content' });
    const err = await extractor()
      .extract(input)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentExtractionError);
    expect((err as PermanentExtractionError).code).toBe(code);
  });

  it('a 4xx with a code that is not on the list in contracts stays permanent, with the generic code', async () => {
    reply = json(422, { code: 'SOMETHING_NEW', message: 'x' });
    const err = await extractor()
      .extract(input)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentExtractionError);
    expect((err as PermanentExtractionError).code).toBe('EXTRACTION_FAILED');
  });

  it.each([401, 403, 404])(
    'a %i answer means our settings are wrong: retried, and kept as AI_SERVICE_MISCONFIGURED',
    async (status) => {
      reply = json(status, { code: 'SERVICE_UNAUTHORIZED', message: 'x' });
      const err = await extractor()
        .extract(input)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransientExtractionError);
      expect((err as TransientExtractionError).code).toBe('AI_SERVICE_MISCONFIGURED');
    },
  );

  it('a body cut off after a 200 is transient, not a schema error', async () => {
    reply = (res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '5000' });
      res.write('{"invoice":');
      setTimeout(() => res.socket?.destroy(), 20);
    };
    await expect(extractor().extract(input)).rejects.toBeInstanceOf(TransientExtractionError);
  });

  it('a 4xx without a usable code becomes EXTRACTION_FAILED, never the raw text', async () => {
    reply = json(400, { code: 'not a code!', message: 'secret' });
    const err = (await extractor()
      .extract(input)
      .catch((e: unknown) => e)) as PermanentExtractionError;
    expect(err.code).toBe('EXTRACTION_FAILED');
    expect(JSON.stringify(err)).not.toContain('secret');
  });

  it.each([500, 502, 503, 408, 429])('a %i answer is transient (retry)', async (status) => {
    reply = json(status, { code: 'ANYTHING' });
    await expect(extractor().extract(input)).rejects.toBeInstanceOf(TransientExtractionError);
  });

  it('a 200 whose body is not a valid invoice is a permanent schema error and leaks nothing', async () => {
    reply = json(200, {
      invoice: { ...(INVOICE as object), total: 1100000.5, buyerSecret: 'Nguyen Van A' },
      warnings: [],
      usage: null,
    });
    const err = (await extractor()
      .extract(input)
      .catch((e: unknown) => e)) as PermanentExtractionError;
    expect(err.code).toBe('EXTRACTION_SCHEMA_INVALID');
    expect(err.message).not.toContain('Nguyen');
  });

  it('a 200 with a non-JSON body is a permanent schema error', async () => {
    reply = (res) => res.writeHead(200).end('<html>proxy error</html>');
    await expect(extractor().extract(input)).rejects.toMatchObject({
      code: 'EXTRACTION_SCHEMA_INVALID',
    });
  });

  it('accepts 1100000.0 as the integer 1100000 (JS parses it so) and rejects a number beyond 2^53', async () => {
    const raw = JSON.stringify({ invoice: INVOICE, warnings: [], usage: null }).replace(
      /"total":(\d+)/,
      '"total":$1.0',
    );
    reply = (res) => res.writeHead(200, { 'content-type': 'application/json' }).end(raw);
    const ok = await extractor().extract(input);
    expect(Number.isInteger(ok.invoice.total)).toBe(true);

    const huge = raw.replace(/"total":\d+\.0/, '"total":90071992547409930000');
    reply = (res) => res.writeHead(200, { 'content-type': 'application/json' }).end(huge);
    await expect(extractor().extract(input)).rejects.toMatchObject({
      code: 'EXTRACTION_SCHEMA_INVALID',
    });
  });

  it.each([
    [503, 'LLM_UNAVAILABLE'],
    [503, 'LLM_TIMEOUT_OR_NETWORK'],
    [429, 'LLM_RATE_LIMITED'],
  ])(
    'a %i from the AI service is transient and keeps its code for when the attempts run out (%s)',
    async (status, code) => {
      reply = json(status, { code, message: 'text that may contain document content' });
      const err = await extractor()
        .extract({ ...input, sourceType: 'pdf' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransientExtractionError);
      expect((err as TransientExtractionError).code).toBe(code);
    },
  );

  it.each([
    [
      'a body that is not JSON (a proxy 502)',
      (res: import('node:http').ServerResponse) =>
        res.writeHead(502).end('<html>Bad gateway</html>'),
    ],
    [
      'a code that is not code-shaped (free text)',
      json(503, { code: 'some TEN-BI-MAT text', message: 'x' }),
    ],
    [
      'a well-formed code that is not on the list in contracts',
      json(503, { code: 'SOMETHING_NEW', message: 'x' }),
    ],
  ])('a 5xx with %s is transient with the generic code and echoes nothing', async (_name, send) => {
    reply = send;
    const err = await extractor()
      .extract({ ...input, sourceType: 'pdf' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientExtractionError);
    expect((err as TransientExtractionError).code).toBe('EXTRACTION_RETRIES_EXHAUSTED');
    expect((err as Error).message).not.toContain('TEN-BI-MAT');
  });

  it.each([
    [422, 'PDF_INVALID'],
    [422, 'LLM_REQUEST_REJECTED'],
    [422, 'EXTRACTION_SCHEMA_INVALID'],
  ])('a %i %s from the LLM path is permanent and keeps the code', async (status, code) => {
    reply = json(status, { code, message: 'x' });
    const err = await extractor()
      .extract({ ...input, sourceType: 'pdf' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentExtractionError);
    expect((err as PermanentExtractionError).code).toBe(code);
  });

  it('the PDF/image path waits for the LLM timeout, not the 15 s of XML: a slow answer is transient once it passes', async () => {
    reply = () => undefined; // never answers
    const started = Date.now();
    await expect(
      extractor({ AI_LLM_TIMEOUT_MS: 300 }).extract({ ...input, sourceType: 'image' }),
    ).rejects.toBeInstanceOf(TransientExtractionError);
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(250);
    expect(waited).toBeLessThan(5_000);
  });

  it('an answer that arrives before the LLM timeout (slower than any XML parse) is accepted', async () => {
    reply = (res) => {
      setTimeout(() => json(200, { invoice: INVOICE, warnings: [], usage: null })(res), 150);
    };
    const out = await extractor({ AI_LLM_TIMEOUT_MS: 2_000 }).extract({
      ...input,
      sourceType: 'pdf',
    });
    expect(out.invoice).toBeDefined();
  });

  it('XML keeps its own limit: an answer slower than AI_LLM_TIMEOUT_MS is still accepted for xml', async () => {
    reply = (res) => {
      setTimeout(() => json(200, { invoice: INVOICE, warnings: [], usage: null })(res), 600);
    };
    const out = await extractor({ AI_LLM_TIMEOUT_MS: 200 }).extract(input); // sourceType xml
    expect(out.invoice).toBeDefined();
  });

  it('a refused connection is transient', async () => {
    const unused = createServer();
    await new Promise<void>((r) => unused.listen(0, '127.0.0.1', r));
    const { port } = unused.address() as AddressInfo;
    await new Promise<void>((r) => unused.close(() => r()));
    const env: Partial<Env> = {
      AI_SERVICE_URL: `http://127.0.0.1:${port}`,
      AI_SERVICE_TOKEN: TOKEN,
    };
    const ex = new HttpAiExtractor({ get: (k: keyof Env) => env[k] } as unknown as ConfigService<
      Env,
      true
    >);
    await expect(ex.extract(input)).rejects.toBeInstanceOf(TransientExtractionError);
  });
});
