import interUrl from '@fontsource/inter/files/inter-latin-400-normal.woff?url';
import serifUrl from '@fontsource/source-serif-4/files/source-serif-4-latin-400-normal.woff?url';
import type { FontSet } from './outlines';

let cached: Promise<FontSet> | undefined;

/** Parse the bundled fonts once (opentype.js is loaded on demand, so it stays out of the initial bundle). */
export function loadFonts(): Promise<FontSet> {
  cached ??= (async () => {
    const { parse } = await import('opentype.js');
    const get = async (url: string) => parse(await (await fetch(url)).arrayBuffer());
    const [sans, serif] = await Promise.all([get(interUrl), get(serifUrl)]);
    return { sans, serif } as unknown as FontSet;
  })();
  cached.catch(() => (cached = undefined));
  return cached;
}
