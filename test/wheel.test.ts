import { describe, expect, it } from 'vitest';
import { SPAN_MAX_KM, SPAN_MIN_KM, wheelSpan } from '../src/ui/wheel';

describe('wheelSpan', () => {
  it('wheel up moves the slider left (smaller view); wheel down moves it right (larger view)', () => {
    expect(wheelSpan(40, -100)).toBeLessThan(40);
    expect(wheelSpan(40, 100)).toBeGreaterThan(40);
  });
  it('a bigger scroll moves further', () => {
    expect(40 - wheelSpan(40, -300)).toBeGreaterThan(40 - wheelSpan(40, -100));
    expect(wheelSpan(40, 300) - 40).toBeGreaterThan(wheelSpan(40, 100) - 40);
  });
  it('always moves at least 1 km, even for tiny trackpad events', () => {
    expect(wheelSpan(40, -1)).toBe(39);
    expect(wheelSpan(40, 1)).toBe(41);
    expect(wheelSpan(5, 2)).toBe(6);
  });
  it('steps are proportional, so zooming feels the same at 5 km and at 100 km', () => {
    expect((40 - wheelSpan(40, -100)) / 40).toBeCloseTo((100 - wheelSpan(100, -100)) / 100, 1);
  });
  it('stays within the slider range', () => {
    expect(wheelSpan(SPAN_MIN_KM, -500)).toBe(SPAN_MIN_KM);
    expect(wheelSpan(SPAN_MAX_KM, 500)).toBe(SPAN_MAX_KM);
    expect(wheelSpan(3, -10000)).toBe(SPAN_MIN_KM);
    expect(wheelSpan(140, 10000)).toBe(SPAN_MAX_KM);
  });
  it('does nothing for a zero scroll', () => {
    expect(wheelSpan(40, 0)).toBe(40);
  });
  it('can reach every value, in both directions, by repeated small scrolls', () => {
    let v = 60;
    for (let i = 0; i < 100; i++) v = wheelSpan(v, -20);
    expect(v).toBe(SPAN_MIN_KM);
    for (let i = 0; i < 400; i++) v = wheelSpan(v, 20);
    expect(v).toBe(SPAN_MAX_KM);
  });
});
