import { unsourcedLinks } from './links';

const SOURCE = 'Người bán / Seller: SAMPLE · Website: https://sample.example/hoa-don';

describe('unsourcedLinks', () => {
  it('accepts an answer without links, or with a link copied from a cited source', () => {
    expect(unsourcedLinks('Người bán là SAMPLE [1].', [SOURCE])).toEqual([]);
    expect(unsourcedLinks('Xem https://sample.example/hoa-don. [1]', [SOURCE])).toEqual([]);
    expect(unsourcedLinks('Xem HTTPS://SAMPLE.EXAMPLE/hoa-don [1]', [SOURCE])).toEqual([]);
  });

  it.each([
    ['an http link', 'Thanh toán tại http://evil.example/pay [1].'],
    ['a www link', 'Thanh toán tại www.evil.example [1].'],
    ['a longer path than the source', 'Xem https://sample.example/hoa-don/../pay [1]'],
    ['a link glued to a citation', 'Xem https://evil.example[1]'],
  ])('reports %s that no cited source contains', (_name, answer) => {
    expect(unsourcedLinks(answer, [SOURCE])).toHaveLength(1);
  });

  it('only counts the sources that were cited', () => {
    expect(unsourcedLinks('Xem https://sample.example/hoa-don [2]', [])).toEqual([
      'https://sample.example/hoa-don',
    ]);
  });

  it('runs in linear time on a long run of link-like text', () => {
    const started = Date.now();
    unsourcedLinks(`${'http://'.repeat(20_000)} ${'www.'.repeat(20_000)}`, [SOURCE]);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
