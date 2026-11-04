import { describe, expect, it } from 'vitest';
import { findEvidence, findInText } from './evidence-match';

describe('findEvidence', () => {
  it('finds text inside one item', () => {
    expect(findEvidence(['Tổng cộng 1.100.000 VND'], '1.100.000')).toEqual({
      start: { item: 0, offset: 10 },
      end: { item: 0, offset: 19 },
    });
  });

  it('finds text split over several items (how pdf.js delivers a line)', () => {
    expect(findEvidence(['Tổng', ' ', 'cộng ', '1.100', '.000'], 'cộng 1.100.000')).toEqual({
      start: { item: 2, offset: 0 },
      end: { item: 4, offset: 4 },
    });
  });

  it('ignores whitespace: items joined by nothing, a space or a line break all match', () => {
    expect(findEvidence(['Số   hoá', 'đơn: 0000123'], 'Số hoá đơn:\n0000123')).not.toBeNull();
  });

  it('is case sensitive and returns null when absent or empty', () => {
    expect(findEvidence(['ABC'], 'abc')).toBeNull();
    expect(findEvidence(['abc'], 'zzz')).toBeNull();
    expect(findEvidence(['abc'], '   ')).toBeNull();
    expect(findEvidence([], 'abc')).toBeNull();
  });
});

describe('findInText', () => {
  it('returns character offsets in the original string', () => {
    const xml = '<HDon><SHDon>0000123</SHDon></HDon>';
    const r = findInText(xml, '0000123');
    expect(r).not.toBeNull();
    expect(xml.slice(r!.start, r!.end)).toBe('0000123');
  });
});
