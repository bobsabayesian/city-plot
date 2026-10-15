import { KIND_LABELS } from './types';
import type { PoolItem } from './select';

const REASON: Record<PoolItem['reason'], string> = {
  'kind off': 'kind switched off',
  hidden: 'hidden',
  'no room': 'no room on the map',
  'not chosen': '',
};

/** One line for the "add landmark" list, e.g. `Eiffel Tower · attraction (kind switched off)`. */
export function describePoolItem(item: PoolItem): string {
  const parts = [item.name, KIND_LABELS[item.kind].toLowerCase().replace(/s$/, '')];
  const why = REASON[item.reason];
  return parts.join(' · ') + (why ? ` (${why})` : '');
}
