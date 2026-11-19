import type { FeatureOverride, LabelKind } from './types';

/** A landmark the user hid, as the "Hidden" list shows it. */
export interface HiddenItem {
  id: string;
  /** its name as drawn (the user's own name for it, if any); undefined when it is not in the data for this view */
  name?: string;
  kind?: LabelKind;
}

/**
 * Every landmark the user hid that the main list does not already show (with its Show box). A hidden landmark can
 * drop out of the main list when others rank above it, or when it is not in the loaded data any more, and this
 * list is the way back to it. `known` are all the places there are names for (candidates, waypoints, own places).
 */
export function hiddenLandmarks(
  overrides: Record<string, FeatureOverride>,
  listed: Iterable<string>,
  known: { id: string; name: string; kind: LabelKind }[],
): HiddenItem[] {
  const shown = new Set(listed);
  const byId = new Map(known.map((k) => [k.id, k]));
  return Object.entries(overrides)
    .filter(([id, ov]) => ov.hidden && !shown.has(id))
    .map(([id, ov]) => {
      const k = byId.get(id);
      return { id, name: (ov.name ?? k?.name)?.trim() || k?.name, kind: k?.kind };
    })
    .sort((a, b) => (a.name === undefined ? 1 : 0) - (b.name === undefined ? 1 : 0) || (a.name ?? a.id).localeCompare(b.name ?? b.id));
}

/** Showing a hidden landmark again: it is also pinned, so it gets a label slot even when the automatic ones are full. */
export const unhide = (ov: FeatureOverride | undefined): FeatureOverride => ({ ...ov, hidden: false, pinned: true });
