import { describe, expect, it } from 'vitest';
import { DEFAULT_ZOOM, stepZoom, ZOOM_STEPS } from './zoom';

describe('stepZoom', () => {
  it('moves one step and comes back', () => {
    expect(stepZoom(100, 1)).toBe(125);
    expect(stepZoom(125, -1)).toBe(100);
  });
  it('stops at both ends', () => {
    expect(stepZoom(ZOOM_STEPS.at(-1)!, 1)).toBe(300);
    expect(stepZoom(ZOOM_STEPS[0], -1)).toBe(50);
  });
  it('snaps a value between steps to the nearest step before moving', () => {
    expect(stepZoom(110, 1)).toBe(125);
    expect(stepZoom(60, -1)).toBe(50);
  });
  it('the default is one of the steps', () => {
    expect(ZOOM_STEPS).toContain(DEFAULT_ZOOM);
  });
});
