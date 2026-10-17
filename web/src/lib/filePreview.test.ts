import { describe, it, expect } from 'vitest';
import { csvRows, inlineImages, PANEL_CSP, prepareHtml, PRINT_LISTENER, saveableCode, snippetName, svgDataUrl } from './filePreview';

const META = `<meta http-equiv="Content-Security-Policy" content="${PANEL_CSP}">`;

describe('PANEL_CSP', () => {
  it('blocks network access but lets CDN scripts run', () => {
    expect(PANEL_CSP).toContain("connect-src 'none'");
    expect(PANEL_CSP).toContain("form-action 'none'");
    expect(PANEL_CSP).toContain("'unsafe-eval'");
    expect(PANEL_CSP).toContain("'unsafe-inline'");
    expect(PANEL_CSP).toMatch(/img-src[^;]*data:[^;]*blob:/);
  });
});

describe('prepareHtml', () => {
  const HEAD = new RegExp(`^<head>${escape(META)}<base target="_blank">${escape(PRINT_LISTENER)}</head>`);

  it('puts the CSP first, before the page has a chance to run anything', () => {
    const out = prepareHtml('<html><head><title>T</title></head><body></body></html>', new Map());
    expect(out).toMatch(HEAD);
    expect(out.endsWith('<html><head><title>T</title></head><body></body></html>')).toBe(true);
  });

  it('keeps a doctype first', () => {
    const out = prepareHtml('<!DOCTYPE html>\n<p>x</p>', new Map());
    expect(out.startsWith('<!DOCTYPE html>\n<head>')).toBe(true);
    expect(out.slice('<!DOCTYPE html>\n'.length)).toMatch(HEAD);
  });

  it('cannot be outrun by a script before the head', () => {
    const out = prepareHtml('<!doctype html><script>fetch("x")</script><html><head></head></html>', new Map());
    expect(out.indexOf(META)).toBeLessThan(out.indexOf('fetch'));
  });

  it('cannot be hidden in a comment', () => {
    const out = prepareHtml('<!doctype html><html><!-- <head> --><head></head></html>', new Map());
    expect(out.indexOf(META)).toBeLessThan(out.indexOf('<!--'));
  });

  it('handles a fragment', () => {
    expect(prepareHtml('<p>x</p>', new Map())).toMatch(new RegExp(`${HEAD.source}<p>x</p>$`));
  });

  it('inlines images', () => {
    expect(prepareHtml('<img src="a.png">', new Map([['a.png', 'data:image/png;base64,AA']]))).toContain('src="data:image/png;base64,AA"');
  });
});

describe('inlineImages', () => {
  const images = new Map([['beach.jpg', 'data:image/jpeg;base64,QQ']]);

  it('replaces src attributes and CSS urls that name a chat image', () => {
    expect(inlineImages('<img src="beach.jpg"><img src=\'beach.jpg\'>', images)).toBe(
      '<img src="data:image/jpeg;base64,QQ"><img src=\'data:image/jpeg;base64,QQ\'>',
    );
    expect(inlineImages('a{background:url(beach.jpg)} b{background:url("beach.jpg")} c{background:url(\'beach.jpg\')}', images)).toBe(
      'a{background:url(data:image/jpeg;base64,QQ)} b{background:url("data:image/jpeg;base64,QQ")} c{background:url(\'data:image/jpeg;base64,QQ\')}',
    );
  });

  it('leaves other references alone', () => {
    const html = '<img src="https://x/beach.jpg"><img src="other.png"><img src="beach.jpg.bak">';
    expect(inlineImages(html, images)).toBe(html);
  });

  it('handles names with regex characters', () => {
    expect(inlineImages('<img src="a (1).png">', new Map([['a (1).png', 'data:x']]))).toBe('<img src="data:x">');
  });
});

describe('svgDataUrl', () => {
  it('is a data: URL, which a browser will not open as a top-level page in OpenChat\'s origin', () => {
    const url = svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg"><text>é</text></svg>');
    expect(url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent(url.slice(url.indexOf(',') + 1))).toBe('<svg xmlns="http://www.w3.org/2000/svg"><text>é</text></svg>');
  });
});

describe('csvRows', () => {
  it('parses quoted fields', () => {
    expect(csvRows('a,b\n"x,1","say ""hi"""')).toEqual({ rows: [['a', 'b'], ['x,1', 'say "hi"']], more: 0 });
  });

  it('keeps newlines inside quotes and ignores a trailing newline', () => {
    expect(csvRows('a,"line1\nline2"\r\nb,c\n')).toEqual({ rows: [['a', 'line1\nline2'], ['b', 'c']], more: 0 });
  });

  it('caps the rows', () => {
    const text = Array.from({ length: 600 }, (_, i) => `r${i},x`).join('\n');
    const out = csvRows(text, 500);
    expect(out.rows).toHaveLength(500);
    expect(out.more).toBe(100);
  });
});

describe('saveableCode', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
  it('needs at least 20 lines', () => {
    expect(saveableCode(lines(19))).toBe(false);
    expect(saveableCode(lines(20))).toBe(true);
    expect(saveableCode(`${lines(19)}\n`)).toBe(false);
  });
});

describe('snippetName', () => {
  it('maps fence languages to extensions', () => {
    expect(snippetName('python')).toBe('snippet.py');
    expect(snippetName('typescript')).toBe('snippet.ts');
    expect(snippetName('html')).toBe('snippet.html');
    expect(snippetName('bash')).toBe('snippet.sh');
    expect(snippetName(undefined)).toBe('snippet.txt');
    expect(snippetName('klingon')).toBe('snippet.txt');
  });
});

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
