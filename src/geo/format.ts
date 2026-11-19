/** Distances as the poster prints them: two decimals under 1, one decimal after. */
const num = (v: number) => (v < 1 ? v.toFixed(2) : v.toFixed(1));
export const formatMiles = (m: number) => `${num(m / 1609.344)} mi`;
export const formatKm = (m: number) => `${num(m / 1000)} km`;

export function formatCoords(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}  ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`;
}

/** 47°36′22″ N  122°19′56″ W: degrees, minutes and whole seconds, as old maps and charts write them. */
export function formatCoordsDms(lat: number, lon: number): string {
  const dms = (v: number) => {
    let s = Math.round(Math.abs(v) * 3600);
    const d = Math.floor(s / 3600);
    s -= d * 3600;
    const m = Math.floor(s / 60);
    return `${d}°${String(m).padStart(2, '0')}′${String(s - m * 60).padStart(2, '0')}″`;
  };
  return `${dms(lat)} ${lat >= 0 ? 'N' : 'S'}  ${dms(lon)} ${lon >= 0 ? 'E' : 'W'}`;
}
