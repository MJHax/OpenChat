import { describe, it, expect } from 'vitest';
import { imageDataUrl, imageForModel, isSvg } from '../src/svg';

const ICON = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="#16a34a"/></svg>');
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

describe('isSvg', () => {
  it('recognises an <svg> root, after an XML prolog, comments, a doctype or a byte-order mark', () => {
    expect(isSvg(ICON)).toBe(true);
    expect(isSvg(Buffer.from('﻿<?xml version="1.0" encoding="UTF-8"?>\n<!-- Recraft -->\n<!DOCTYPE svg>\n<svg>'))).toBe(true);
    expect(isSvg(Buffer.from('  \n<SVG width="1">'))).toBe(true);
  });

  it('rejects other XML, HTML and binary data', () => {
    expect(isSvg(Buffer.from('<?xml version="1.0"?><rss/>'))).toBe(false);
    expect(isSvg(Buffer.from('<html><svg></svg></html>'))).toBe(false);
    expect(isSvg(Buffer.from('<svgx>'))).toBe(false);
    expect(isSvg(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
  });
});

describe('imageForModel', () => {
  it('draws an SVG to a PNG', () => {
    const out = imageForModel('image/svg+xml', ICON);
    expect(out.mime).toBe('image/png');
    expect([...out.data.subarray(0, 4)]).toEqual(PNG_SIGNATURE);
    expect(imageDataUrl('image/svg+xml', ICON)).toMatch(/^data:image\/png;base64,/);
  });

  it('passes raster images through untouched', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 1]);
    expect(imageForModel('image/jpeg', jpeg)).toEqual({ mime: 'image/jpeg', data: jpeg });
  });
});
