import { parseIfMatch } from './if-match';

describe('parseIfMatch', () => {
  it.each([
    ['"1"', 1],
    ['"42"', 42],
  ])('reads %s as a version', (header, version) => {
    expect(parseIfMatch(header)).toBe(version);
  });

  it.each([undefined, '', '*', '1', '"0"', '"-1"', '"1.5"', 'W/"1"', '"1", "2"', '"12345678901"'])(
    'refuses %s',
    (header) => {
      expect(parseIfMatch(header)).toBeNull();
    },
  );
});
