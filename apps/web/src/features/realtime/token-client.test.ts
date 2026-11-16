import { describe, expect, it } from 'vitest';
import { fetchRealtimeToken } from './token-client';

const answer =
  (status: number, body: unknown = {}) =>
  () =>
    Promise.resolve(Response.json(body, { status }));

describe('fetchRealtimeToken', () => {
  it('returns the token and the socket url', async () => {
    const r = await fetchRealtimeToken(
      answer(200, { token: 'a.b.c', expiresIn: 60, url: 'http://localhost:3001' }),
    );
    expect(r).toEqual({ kind: 'ok', token: 'a.b.c', url: 'http://localhost:3001' });
  });

  it.each([
    [404, 'off'],
    [403, 'off'],
    [401, 'signed-out'],
    [429, 'error'],
    [502, 'error'],
  ])('maps %i to %s', async (status, kind) => {
    expect(await fetchRealtimeToken(answer(status))).toEqual({ kind });
  });

  it('treats a malformed answer or a network failure as an error, never throws', async () => {
    expect(await fetchRealtimeToken(answer(200, { token: '' }))).toEqual({ kind: 'error' });
    expect(await fetchRealtimeToken(() => Promise.reject(new TypeError('offline')))).toEqual({
      kind: 'error',
    });
  });

  it('gives up on a web server that does not answer', async () => {
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
      );
    expect(await fetchRealtimeToken(hang, 20)).toEqual({ kind: 'error' });
  });
});
