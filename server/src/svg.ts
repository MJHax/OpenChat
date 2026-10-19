import { Resvg } from '@resvg/resvg-js';

export const SVG_MIME = 'image/svg+xml';

/** Whether the bytes are an SVG document: an XML prolog or comments are allowed ahead of the <svg> root. */
export function isSvg(b: Uint8Array): boolean {
  const head = Buffer.from(b.subarray(0, 4096)).toString('utf8').replace(/^﻿/, '').trimStart();
  if (!head.startsWith('<')) return false;
  return /^(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(head);
}

/** Width a rasterised SVG is drawn at: plenty for a model to read it. */
const RASTER_WIDTH = 1024;

/**
 * An image as a model can take it. Models read raster images only, so an SVG is drawn to a PNG on white (a transparent
 * icon would otherwise come out as dark shapes on black); every other type passes through unchanged.
 */
export function imageForModel(mime: string, data: Buffer): { mime: string; data: Buffer } {
  if (mime !== SVG_MIME) return { mime, data };
  const png = new Resvg(data, { fitTo: { mode: 'width', value: RASTER_WIDTH }, background: 'white' }).render().asPng();
  return { mime: 'image/png', data: Buffer.from(png) };
}

export const imageDataUrl = (mime: string, data: Buffer): string => {
  const image = imageForModel(mime, data);
  return `data:${image.mime};base64,${image.data.toString('base64')}`;
};
