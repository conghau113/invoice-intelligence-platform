import { describe, expect, it } from 'vitest';
import { rateLimited } from './bff-error';

const upstream = (status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ code: 'RATE_LIMITED', detail: 'SAMPLE upstream text' }), {
    status,
    headers,
  });

describe('rateLimited', () => {
  it('is null for anything but 429', () => {
    for (const status of [200, 400, 403, 500, 503])
      expect(rateLimited(upstream(status))).toBeNull();
  });

  it('answers 429 RATE_LIMITED with the Retry-After seconds', async () => {
    const res = rateLimited(upstream(429, { 'retry-after': '12' }));
    expect(res?.status).toBe(429);
    expect(res?.headers.get('retry-after')).toBe('12');
    expect(await res?.json()).toEqual({ code: 'RATE_LIMITED' });
  });

  it.each(['Wed, 21 Oct 2026 07:28:00 GMT', '-1', '1.5', '9999999', '5, 6'])(
    'drops a Retry-After that is not plain seconds: %j',
    (value) => {
      const res = rateLimited(upstream(429, { 'retry-after': value }));
      expect(res?.status).toBe(429);
      expect(res?.headers.get('retry-after')).toBeNull();
    },
  );

  it('still answers 429 when the API sent no Retry-After', () => {
    const res = rateLimited(upstream(429));
    expect(res?.status).toBe(429);
    expect(res?.headers.get('retry-after')).toBeNull();
  });
});
