import { describe, expect, it } from 'vitest';
import { rehypeWordFade, WORD_FADE_MS, type HastNode } from './wordFade';

const text = (value: string): HastNode => ({ type: 'text', value });
const el = (tagName: string, children: HastNode[]): HastNode => ({ type: 'element', tagName, properties: {}, children });
const root = (children: HastNode[]): HastNode => ({ type: 'root', children });

function run(tree: HastNode, seen: number[], now: number): HastNode {
  rehypeWordFade({ seen, now })(tree);
  return tree;
}

/** The tree as a string: plain text as is, fading words as [word]. */
function show(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  const inner = (node.children ?? []).map(show).join('');
  if (node.tagName === 'span' && (node.properties?.className as string[] | undefined)?.includes('word-fade')) return `[${inner}]`;
  return node.type === 'root' ? inner : `<${node.tagName}>${inner}</${node.tagName}>`;
}

describe('rehypeWordFade', () => {
  it('wraps every new word and keeps the spacing between them', () => {
    const tree = run(root([el('p', [text('Hello  there,\nfriend ')])]), [], 1000);
    expect(show(tree)).toBe('<p>[Hello]  [there,]\n[friend] </p>');
  });

  it('records when each word was first seen and keeps earlier times', () => {
    const seen = [500];
    run(root([el('p', [text('one two')])]), seen, 1000);
    expect(seen).toEqual([500, 1000]);
    run(root([el('p', [text('one two three')])]), seen, 1100);
    expect(seen).toEqual([500, 1000, 1100]);
  });

  it('leaves words older than the fade as plain text', () => {
    const seen = [0, 1000 - WORD_FADE_MS, 1000 - WORD_FADE_MS + 1];
    const tree = run(root([el('p', [text('old older new newest')])]), seen, 1000);
    expect(show(tree)).toBe('<p>old older [new] [newest]</p>');
  });

  it('puts the time the word was first seen on its span', () => {
    const tree = run(root([el('p', [text('hi')])]), [990], 1000);
    const span = tree.children![0].children![0];
    expect(span.properties).toEqual({ className: ['word-fade'], dataSeen: 990 });
  });

  it('counts words across nested elements in document order', () => {
    const seen = [0, 0];
    const tree = run(root([
      el('p', [text('a '), el('strong', [text('b c')])]),
      el('pre', [el('code', [text('d')])]),
    ]), seen, 1000);
    expect(show(tree)).toBe('<p>a <strong>b [c]</strong></p><pre><code>[d]</code></pre>');
    expect(seen).toEqual([0, 0, 1000, 1000]);
  });

  it('leaves whitespace-only text alone', () => {
    const seen: number[] = [];
    const tree = run(root([el('p', [text('x')]), text('\n'), el('p', [text('y')])]), seen, 1000);
    expect(show(tree)).toBe('<p>[x]</p>\n<p>[y]</p>');
    expect(seen).toHaveLength(2);
  });
});
