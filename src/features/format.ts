import { formatFeet, formatMeters } from '../geo/stats';
import { KIND_LABELS } from './types';
import type { PoolItem } from './select';

const REASON: Record<PoolItem['reason'], string> = {
  'kind off': 'kind switched off',
  hidden: 'hidden',
  'no room': 'no room on the map',
  'not chosen': '',
};

/** One line for the "add landmark" list, e.g. `Little Tahoma · peak · 9,840 ft (kind switched off)`. */
export function describePoolItem(item: PoolItem, units: 'imperial' | 'metric'): string {
  const parts = [item.name, KIND_LABELS[item.kind].toLowerCase().replace(/s$/, '')];
  if (item.ele !== undefined) parts.push(units === 'imperial' ? formatFeet(item.ele) : formatMeters(item.ele));
  const why = REASON[item.reason];
  return parts.join(' · ') + (why ? ` (${why})` : '');
}
