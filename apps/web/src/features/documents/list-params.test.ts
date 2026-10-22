import { describe, expect, it } from 'vitest';
import { hasFilters, parseListParams, toApiQuery, toQuery } from './list-params';

const parse = (qs: string) => parseListParams(new URLSearchParams(qs));
const base = { sort: '-createdAt', page: 1, pageSize: 20 };

describe('parseListParams', () => {
  it('defaults to newest first, page 1, 20 rows, no filter', () => {
    expect(parse('')).toEqual(base);
  });

  it('reads every parameter', () => {
    expect(
      parse(
        'status=failed&type=pdf&from=2026-09-01&to=2026-09-30&sort=createdAt&page=7&pageSize=50',
      ),
    ).toEqual({
      status: 'failed',
      type: 'pdf',
      from: '2026-09-01',
      to: '2026-09-30',
      sort: 'createdAt',
      page: 7,
      pageSize: 50,
    });
  });

  it('drops what is unknown or malformed instead of failing', () => {
    expect(
      parse(
        'status=done&type=exe&from=yesterday&to=2026-02-30&sort=status&page=0&pageSize=33&cursor=abc&x=1',
      ),
    ).toEqual(base);
    expect(parse('page=-2').page).toBe(1);
    expect(parse('page=2.5').page).toBe(1);
    expect(parse('page=last').page).toBe(1);
    expect(parse('page=10001').page).toBe(1);
    expect(parse('page=10000').page).toBe(10000);
  });

  it('only accepts the page sizes the screen offers', () => {
    for (const size of [10, 20, 50, 100]) expect(parse(`pageSize=${size}`).pageSize).toBe(size);
    expect(parse('pageSize=25').pageSize).toBe(20);
  });

  it('ignores the end of a reversed range', () => {
    expect(parse('from=2026-10-02&to=2026-10-01')).toEqual({ ...base, from: '2026-10-02' });
  });
});

describe('toQuery / toApiQuery', () => {
  it('leaves defaults out of the URL and round-trips', () => {
    const p = parse('status=queued&sort=createdAt&page=3&pageSize=50');
    expect(toQuery(p)).toEqual({
      status: 'queued',
      sort: 'createdAt',
      page: '3',
      pageSize: '50',
    });
    expect(toQuery(parse(''))).toEqual({});
    expect(parse(new URLSearchParams(toQuery(p)).toString())).toEqual(p);
  });

  it("asks the API with page and limit (the API's name for the page size)", () => {
    expect(toApiQuery(parse('type=xml'))).toBe('type=xml&limit=20');
    expect(toApiQuery(parse('page=4&pageSize=10'))).toBe('page=4&limit=10');
  });
});

describe('hasFilters', () => {
  it('is about filters, not sort or paging', () => {
    expect(hasFilters(parse('sort=createdAt&page=3&pageSize=50'))).toBe(false);
    expect(hasFilters(parse('status=failed'))).toBe(true);
  });
});
