/** How long a newly shown word of a live reply takes to fade in. */
export const WORD_FADE_MS = 250;

/** The parts of a hast node this plugin reads and writes. */
export interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/**
 * A rehype plugin for a reply that is still appearing. It numbers the rendered words (runs of non-space characters, in
 * document order) and records in `seen[i]` when word i was first rendered, so a word keeps its place in the fade however
 * often the reply is re-rendered. Words first seen less than WORD_FADE_MS before `now` are wrapped in
 * `<span class="word-fade" data-seen="…">` for the live reply to animate; older words stay plain text.
 */
export function rehypeWordFade({ seen, now }: { seen: number[]; now: number }) {
  return (tree: HastNode) => {
    let index = 0;
    const walk = (node: HastNode) => {
      if (!node.children) return;
      const out: HastNode[] = [];
      const pushText = (value: string) => {
        const last = out[out.length - 1];
        if (last?.type === 'text' && !last.tagName) last.value += value;
        else out.push({ type: 'text', value });
      };
      for (const child of node.children) {
        if (child.type !== 'text' || !child.value?.trim()) {
          walk(child);
          out.push(child);
          continue;
        }
        for (const part of child.value.split(/(\S+)/)) {
          if (!part) continue;
          if (!/\S/.test(part)) { pushText(part); continue; }
          const i = index++;
          seen[i] ??= now;
          if (now - seen[i] < WORD_FADE_MS) {
            out.push({ type: 'element', tagName: 'span', properties: { className: ['word-fade'], dataSeen: seen[i] }, children: [{ type: 'text', value: part }] });
          } else {
            pushText(part);
          }
        }
      }
      node.children = out;
    };
    walk(tree);
  };
}
