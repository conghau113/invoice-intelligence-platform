import { checkCitations } from './citations';

describe('checkCitations', () => {
  it('accepts markers of retrieved sources, in order of first use, without repeats', () => {
    expect(checkCitations('Bán bởi SAMPLE [2]. Tổng 1.100.000 [1][2].', 3)).toEqual({
      ok: true,
      cited: [2, 1],
    });
  });

  it('finds a marker right after a bracket that is not closed', () => {
    expect(checkCitations('Ghi chú [xem SAMPLE [1]', 1)).toEqual({ ok: true, cited: [1] });
    expect(checkCitations('Ghi chú [xem SAMPLE [7]', 1)).toEqual({
      ok: false,
      problem: 'UNKNOWN_SOURCE',
    });
  });

  it.each([
    ['a source that was not retrieved', 'SAMPLE [6]', 5],
    ['source zero', 'SAMPLE [0]', 5],
    ['a huge number', 'SAMPLE [99999999999999999999]', 5],
    ['one good and one unknown', 'SAMPLE [1] and [4]', 3],
  ])('refuses %s', (_name, answer, count) => {
    expect(checkCitations(answer, count)).toEqual({ ok: false, problem: 'UNKNOWN_SOURCE' });
  });

  it.each([
    'SAMPLE [1, 9]',
    'SAMPLE [1-9]',
    'SAMPLE [1;2]',
    'SAMPLE [ 1 ]',
    // Longer than any bound a short-bracket regex would have: still a list (code review).
    'SAMPLE [1] and [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]',
  ])('refuses the list %s instead of guessing what it cites', (answer) => {
    expect(checkCitations(answer, 9)).toEqual({ ok: false, problem: 'MALFORMED_CITATION' });
  });

  it.each([
    ['no bracket at all', 'Người bán là SAMPLE.'],
    ['only text in brackets', 'Người bán là [SAMPLE] [sic].'],
    ['an empty answer', ''],
    ['a marker broken over two lines', 'SAMPLE [1\n]'],
  ])('reports %s as uncited', (_name, answer) => {
    expect(checkCitations(answer, 3)).toEqual({ ok: false, problem: 'NO_CITATION' });
  });

  it('treats a long bracketed text as text, in linear time', () => {
    const long = `[${'SAMPLE '.repeat(5_000)}] ${'['.repeat(50_000)} ${'[1 '.repeat(20_000)}`;
    const started = Date.now();
    expect(checkCitations(`${long} SAMPLE [1]`, 1)).toEqual({ ok: true, cited: [1] });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('refuses a run of digits too long to be a source number', () => {
    expect(checkCitations(`SAMPLE [${'1'.repeat(30)}]`, 5)).toEqual({
      ok: false,
      problem: 'UNKNOWN_SOURCE',
    });
  });
});
