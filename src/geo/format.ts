/** Distances as the poster prints them: two decimals under 1, one decimal after. */
const num = (v: number) => (v < 1 ? v.toFixed(2) : v.toFixed(1));
export const formatMiles = (m: number) => `${num(m / 1609.344)} mi`;
export const formatKm = (m: number) => `${num(m / 1000)} km`;

export function formatCoords(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}  ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`;
}
