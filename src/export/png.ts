import { sceneToSvg } from './svg';
import type { Scene } from '../scene/types';
import { loadFonts } from './fonts';
import { prepareScene } from './outlines';

/** Conservative limits that every mainstream browser canvas accepts. */
export const MAX_SIDE_PX = 12000;
export const MAX_AREA_PX = 100_000_000;

export interface PngSize { width: number; height: number; dpi: number; capped: boolean }

/** Pixel size for a poster at `dpi`, scaled down if the browser couldn't make a canvas that large. */
export function pngSize(widthMm: number, heightMm: number, dpi: number): PngSize {
  const w = (widthMm / 25.4) * dpi;
  const h = (heightMm / 25.4) * dpi;
  const k = Math.min(1, MAX_SIDE_PX / Math.max(w, h), Math.sqrt(MAX_AREA_PX / (w * h)));
  return { width: Math.round(w * k), height: Math.round(h * k), dpi: Math.round(dpi * k), capped: k < 1 };
}

/** Rasterize the scene (paper color included) to a PNG blob. */
export async function sceneToPng(scene: Scene, dpi: number): Promise<{ blob: Blob; size: PngSize }> {
  const size = pngSize(scene.widthMm, scene.heightMm, dpi);
  // The image renderer can't see page fonts, so text is always outlined for PNG.
  const svg = sceneToSvg(prepareScene(scene, 'print', await loadFonts()), { paper: true }).replace(
    /width="[\d.]+mm" height="[\d.]+mm"/,
    `width="${size.width}" height="${size.height}"`,
  );
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    canvas.getContext('2d')!.drawImage(img, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob>((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG encoding failed'))), 'image/png'),
    );
    return { blob, size };
  } finally {
    URL.revokeObjectURL(url);
  }
}
