# Discussions: words fade in as they appear

Date: 2026-11-11

## Why

With "Type out replies" on, a live reply grows by whole words about six times a second, and each word goes from
invisible to fully visible in one frame. With it off, text arrives in bursts as the model sends it. Either way the
reply grows in small jumps, which the owner finds abrupt.

## Goals, non-goals, anti-goals

Goals:
- Each newly shown word in the live reply fades in over a short time (250 ms), so the reveal reads as a flow.
- Works the same with "Type out replies" on or off.

Non-goals:
- Fading the whole reply in, or changing the reveal pace, the beat or the loop.
- Any new option. People who ask their system to reduce motion get no fade; nobody else needs a switch.
- Saved messages, chats, Compare, or anything outside the live discussion reply.

Anti-goals (a failure even if it "works"):
- A word that has already appeared fading in again. The live reply is re-rendered from Markdown on every tick, and a
  list or code block finishing can rebuild its elements; a rebuilt word must pick up its fade where it was.
- Changing what is copied or read: Copy on a code block, the text in the DOM and the saved message stay the same.
- Slowing long replies: only words still fading get wrapped in an element.

## The design

1. **A rehype plugin** (`web/src/lib/wordFade.ts`, `rehypeWordFade`) runs after `rehype-highlight` for the live reply
   only. It numbers the rendered words (runs of non-space characters in text nodes, in document order) and keeps
   `seen[i]`, the time word *i* was first rendered, filling it in the first time a render reaches it. A word seen less
   than 250 ms ago is wrapped in `<span class="word-fade" data-seen="…">`; older words stay plain text.
2. **`Markdown`** takes an optional `fade={{ seen }}`; with it, the plugin is added.
3. **The live reply** (`LiveLine` in `DiscussionTranscript.tsx`) keeps `seen` in a ref, cleared when a new turn starts
   from empty text. After each render, a layout effect starts a Web Animations fade (opacity 0 → 1, 250 ms, ease-out,
   `fill: 'both'`) on every `.word-fade` element that doesn't have one yet, with its `startTime` set to `seen` (the
   document timeline and `performance.now()` share a clock), so it doesn't start a frame late. A rebuilt
   element is a new element, so it gets a new animation that resumes at the right point; an element React kept keeps
   its running animation. Running before paint, no word flashes at full opacity first.
4. **Reduced motion:** with `prefers-reduced-motion: reduce`, no animation starts and words appear as before.

## Testing

The plugin is pure and tested on hast trees in `web/src/lib/wordFade.test.ts`: words split out with their spacing
kept, only recent words wrapped, `seen` kept across renders, words inside nested elements and code counted in order.
The animation is checked by hand in the browser with the fake local server.
