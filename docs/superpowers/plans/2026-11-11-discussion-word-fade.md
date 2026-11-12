# Discussion Word Fade Implementation Plan

**Goal:** Fade each newly shown word of a live discussion reply in over 250 ms.

**Spec:** `docs/superpowers/specs/2026-11-11-discussion-word-fade-design.md`

## Global Constraints

- No new dependencies; the plugin uses its own minimal hast node type.
- Only the live reply gets the plugin; saved messages render exactly as before.
- `prefers-reduced-motion: reduce` starts no animation.
- Run `npm test` and `npm run typecheck` before committing.

### Task 1: `rehypeWordFade` plugin

- [ ] Write `web/src/lib/wordFade.test.ts`: splits text into words and keeps spaces; wraps only words seen < 250 ms
      ago; fills `seen` once and keeps earlier times; counts words across nested elements in document order; leaves
      whitespace-only text nodes alone.
- [ ] Implement `web/src/lib/wordFade.ts` (`WORD_FADE_MS`, `rehypeWordFade({ seen, now })`).

### Task 2: Markdown option

- [ ] `Markdown` takes `fade?: { seen: number[] }` and adds the plugin after `rehype-highlight`.

### Task 3: Live reply animation

- [ ] `LiveLine` keeps `seen` in a ref (cleared on empty text), passes it to `Markdown`, and in a layout effect starts
      a Web Animations fade on new `.word-fade` elements with `startTime = data-seen`, skipped under reduced motion.

### Task 4: Check

- [ ] `npm test`, `npm run typecheck`; watch a discussion against `npm run fake-local` with typing on and off.
