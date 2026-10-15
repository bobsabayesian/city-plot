export interface TrackPoint {
  lat: number;
  lon: number;
  /** meters */
  ele?: number;
  /** ms since epoch */
  time?: number;
}
