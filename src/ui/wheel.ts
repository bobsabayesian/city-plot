export const SPAN_MIN_KM = 2;
export const SPAN_MAX_KM = 150;

/**
 * New view width after a mouse-wheel event over the feature block. Wheel up (negative deltaY) moves the
 * slider left, i.e. a smaller view and a closer zoom; wheel down moves it right. The step scales with
 * deltaY so a notch on a mouse is a clear step and a trackpad's many tiny events stay smooth.
 */
export function wheelSpan(currentKm: number, deltaY: number): number {
  if (deltaY === 0) return currentKm;
  const next = Math.round(currentKm * Math.exp(deltaY * 0.0015));
  const stepped = next === Math.round(currentKm) ? Math.round(currentKm) + Math.sign(deltaY) : next; // always move at least 1 km
  return Math.min(SPAN_MAX_KM, Math.max(SPAN_MIN_KM, stepped));
}
