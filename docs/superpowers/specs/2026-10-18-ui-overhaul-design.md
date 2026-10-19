# UI/UX overhaul: modern AI look

Date: 2026-10-18

Reference mockup: [2026-10-18-ui-overhaul-mockup.html](2026-10-18-ui-overhaul-mockup.html). Open it in a browser. It's
a throwaway prototype, but the owner reviewed and approved it. Where this doc and the mockup disagree, this doc wins.

## Why

OpenChat works, but it looks like a utility. The owner wants it to feel like a modern AI product: pleasing to look at,
with menus that are easy to find your way around and animations that are satisfying but simple. Right now:

- The palette is warm cream and terracotta (close to Claude's), with a serif empty-state heading.
- Icons are Unicode glyphs (☰ ⟨ ＋ ✕ 🎬) that render differently on every OS.
- The sidebar stacks a cramped 4-way mode switch, New, search, the thread list and text links.
- Theme is buried in Settings → General → "Other".
- There is almost no motion.

The owner liked the BeUI "TiltCard" from 21st.dev (3D tilt toward the cursor, with a soft radial glare) and wants that
card style used in the app.

## Goals, non-goals, anti-goals

Goals:
- A mostly black-and-white UI with **one** accent color, switchable in Settings: **Blue, Orange, Green or Rainbow**.
- A **light/dark** mode toggle that's reachable in one click, plus the full Light/Dark/System choice in Settings.
- A **Flat/Vivid** "Color style" choice in Settings, next to theme and accent (details below).
- Clearer organization: an icon rail for the main areas, a thread panel, a command palette, and a Settings overlay.
- Satisfying, simple animations everywhere it helps. They always respect reduced motion and can be switched off.
- Tilt cards where they add delight without hurting reading.
- Every page restyled in the same system: Chat, Images, Video, Discussions, Model Library, Stats, Settings, plus
  popovers, toasts, the lightbox and the file panel.

Non-goals:
- New product features. Behavior stays the same; only presentation and organization change. (The command palette and
  the context/cost popovers reorganize existing functions; they don't add new ones.)
- Server or database changes beyond the new appearance settings.
- A mobile layout. Desktop-first, but the app must not break at narrow widths (see Layout).
- Migrating to Tailwind or shadcn.

Anti-goals (it fails even if it technically works when...):
- **Color is everywhere.** The accent must stay scarce. It goes on a few highlights, never on large surfaces or body
  text.
- **Animations get in the way.** Nothing may delay input or block a click. No animation longer than ~500 ms on an
  interaction path, and no motion on text you are reading.
- **Tilt on reading surfaces.** Never on chat messages, menus, popovers or forms.
- **A feature disappears or gets harder to reach.** Everything reachable today stays reachable, in the same number of
  clicks or fewer. The one accepted exception is turning Compare on mid-conversation (see Composer).
- **The theme flashes** the wrong colors on load.

## Visual system

### Neutrals

| Token | Dark | Light |
|---|---|---|
| `--bg` | `#0a0a0a` | `#ffffff` |
| `--panel` (rail, thread panel, sheets) | `#0f0f0f` | `#fafafa` |
| `--surface` (cards, inputs, popovers) | `#151515` | `#ffffff` |
| `--surface-2` (hover, chips, active) | `#1c1c1c` | `#f4f4f5` |
| `--border` | `#242424` | `#e7e7e7` |
| `--border-strong` | `#333333` | `#d4d4d4` |
| `--text` | `#fafafa` | `#0a0a0a` |
| `--muted` | `#8f8f8f` | `#6b6b6b` |
| `--faint` | `#5a5a5a` | `#a3a3a3` |

Danger and warning colors stay semantic (red/amber) and are not tied to the accent. Code blocks stay dark in both
modes.

### Accent

Set by `data-accent` on `<html>`. Each accent defines `--accent` (a solid color, used for text, borders, rings and focus
glows) and `--accent-fill` (the paint for filled elements).

| Accent | Solid | Vivid duotone stops |
|---|---|---|
| Blue | `#3b82f6` | `#2563eb → #3b82f6 → #22d3ee → #6366f1` |
| Orange | `#f97316` | `#ea580c → #f97316 → #f59e0b → #f43f5e` |
| Green | `#22c55e` (`#16a34a` in light mode) | `#16a34a → #22c55e → #a3e635 → #14b8a6` |
| Rainbow | `#8b5cf6` as the solid stand-in | `#ff5f6d → #ffc371 → #47e891 → #3bb2ff → #a066ff` |

Where the accent appears (the complete list; anything else stays neutral):
- the send button and other primary buttons
- the logo mark
- the active-nav marker on the rail and the active thread
- icons on the active rail item
- the focus glow on the composer and inputs
- selected states (checks, selected cards, switches that are on)
- the greeting highlight word
- the busy dot on a thread that's generating
- progress bars and rings (context, spending)
- the streaming cursor

### Color style: Flat or Vivid

Chosen by the owner. It sits in Settings → Appearance as two preview cards, between Accent and Motion.

- **Flat:** `--accent-fill` is the solid color. Clean and quiet.
- **Vivid** (default):
  - `--accent-fill` becomes the accent's duotone gradient, drifting slowly (8 s loop, `background-size: 300%`).
  - A faint ambient "aurora" glow (two blurred radial gradients in the accent's hues) drifts at the top of the main
    area. It sits at about 13% opacity in dark mode and 9% in light mode.
  - Suggestion-card icon tiles get an accent tint.
  - Tilt cards get an accent edge and soft shadow on hover, and their glare picks up the accent.
  - The send button and the rail marker get a soft accent glow.
  - User chat bubbles get a very faint accent tint.
- **Rainbow is always vivid.** With Rainbow selected, the Color style cards are dimmed and not clickable, and the hint
  says "Rainbow is always vivid."

### Typography and icons

- **Font:** Geist for UI and Geist Mono for code and numbers. *My call:* bundle them with npm (`@fontsource-variable/geist`
  and `@fontsource-variable/geist-mono` or equivalent) rather than loading Google Fonts at runtime.
- **Headings:** sans, with tight tracking. Drop the serif empty-state heading.
- **Icons:** `lucide-react` replaces every Unicode glyph and emoji used as an icon. That includes the 🎬 in the video
  toast.

### Shape, depth and motion

- **Radii:** about 8 px for small controls, 10–14 px for cards and inputs, 18–20 px for the composer and sheets.
- **Shadows:** only on floating layers (popovers, sheets, the app frame), never on inline content.
- **Easing:** ease-out `cubic-bezier(0.16, 1, 0.3, 1)` for entrances, and a gentle spring
  (`cubic-bezier(0.34, 1.56, 0.64, 1)` or motion springs) for presses, indicators and pops.

## Layout and navigation

### Icon rail (about 60 px, always visible)

Top to bottom:
1. The logo mark (accent fill).
2. **Chats, Images, Video, Discussions.**
3. A divider.
4. **Model Library, Stats.**
5. A spacer.
6. A **light/dark toggle** (sun/moon). It flips between light and dark directly; if the setting was System, it becomes
   the opposite of what's currently showing.
7. **Settings.**

Behavior:
- Each item has a tooltip on hover.
- The active item gets a raised tile and an accent bar, both sliding between items with a spring.
- While on Model Library, Stats or Settings, the thread panel keeps showing the last mode, as it does today.

### Thread panel (about 260 px, collapsible)

- **Header:** the mode name ("Chats", "Images", ...) and a ＋ button (New chat, New image, ...).
- **Search field:** shows a `Ctrl K` hint. Clicking it opens the command palette.
- **Thread list:**
  - Same date groups as today, with uppercase small labels.
  - Hovering an item tints it and nudges it 2 px right.
  - The active item gets an accent bar on its left edge.
  - A busy item shows a pulsing accent dot. Image threads keep their thumbnails.
  - Rename and delete stay on hover.
- **Usage card** at the bottom: this month's spend against the monthly limit, as a thin accent bar. It shows only when
  a monthly limit is set. When none is set, show the month's spend alone.
- **Collapse:** the thread panel collapses to nothing (the rail stays), replacing today's collapsed sidebar. *My call:*
  - a collapse button sits in the panel header
  - clicking the active mode's rail icon toggles the panel back open
  - Ctrl/Cmd+B toggles it too

### Command palette (Ctrl/Cmd+K)

A centered overlay with a search box and grouped results. It only reorganizes things the app already does:
- **Chats:** full-text search over all threads, using the existing search API, with highlighted snippets. Opening a
  result jumps to that message, as sidebar search does today.
- **Create:** New chat, New image, New video, New discussion.
- **Go to:** Model Library, Stats, and each Settings tab.
- **Appearance:** switch theme, accent and color style.

Use arrow keys to move, Enter to choose and Escape to close. It opens with a scale-and-fade pop.

### Settings as an overlay

- Settings opens as a centered sheet over the current page, which stays rendered and blurred behind it. Inside the
  sheet, tabs sit on the left.
- Escape, the ✕ button or a click on the backdrop closes it and returns to where you were.
- The route stays `#/settings/<tab>[/<section>]` so deep links keep working. Opening Settings from a fresh page load
  shows it over the Chat home.
- **Tabs:** General, Appearance, Memory, Data, Spending limits.
  - Spending limits moves out of General into its own tab.
  - Theme moves out of General → "Other" into Appearance.
  - `SPENDING_LIMITS_HREF` and any other links into the old location must point to the new tab. The old
    `#/settings/general/limits` link should still land on Spending limits.
- **Appearance tab:**
  - Theme: three preview cards (Light, Dark, System).
  - Accent: four large swatches, each showing a check when selected.
  - Color style: Flat and Vivid preview cards.
  - Motion: two switches, "Animations" and "Tilt cards".

### Narrow windows

Below about 900 px, the thread panel collapses automatically and opens as an overlay. The rail stays. Nothing may
scroll horizontally.

## Screens

### Chat home (no chat open)

- A centered greeting, "Good evening." (or morning/afternoon by local time), followed by a highlight phrase painted
  with the accent fill. Below it, a one-line subtitle.
- The floating composer (below).
- Under the composer, four **tilt suggestion cards**: Write, Code, Imagine, Discuss.
  - Write and Code prefill the composer with a starter prompt.
  - Imagine goes to New image.
  - Discuss goes to New discussion.
- The existing setup hints (no API key, no models) replace the suggestions while they apply.
- **Header:** the home screen has the same ⋯ menu as a conversation (Chat instructions, Compare models). Instructions
  set here carry over to the new chat, as draft instructions do today. *My call:* this replaces the mockup's separate
  "Instructions" chip, so both screens match.

### Composer (Chat; the same pattern for Images, Video and Discussion inputs)

- A large rounded box: the textarea on top and a row of controls below.
- **Controls, left to right:**
  - attach
  - web search toggle
  - **compare toggle** (owner's decision): only shown before the first message is sent, i.e. on the Chat home. It
    carries over to the new chat, as today.
  - **model chip:** accent dot plus model name. It opens a model picker popover listing your models with price and
    context size, and a check on the current one.
  - **reasoning effort chip**
  - a spacer
  - the send button (accent fill). It becomes a stop button while streaming.
- **Focus:** an accent ring plus a soft accent glow.
- **Compare mode:** when compare is on, the model chip becomes a multi-select showing the chosen models (keep today's
  limit and rules). It has a ✕ that turns compare off, so compare is always visible and one click to turn off.
- **Where Compare lives** (owner's decision): always in the ⋯ menu (home and conversation), plus the composer toggle
  before the first message. Turning compare **on** mid-conversation takes two clicks (⋯ → Compare models). That is an
  accepted exception to the click-count anti-goal.
- Attachment chips, drag-and-drop and every existing warning or blocked-send message stay. Only their styling changes.

### Chat conversation

**Header**, left to right:
1. The title.
2. The **context chip**: a small progress ring plus "12% context". It opens the existing context popover (breakdown,
   Summarize & continue).
3. The **cost chip**: chart icon plus "$0.042". It opens the existing chat stats popover.
4. A **⋯ menu** holding only **Chat instructions** (the existing instructions editor) and **Compare models** (turns
   compare mode on or off).

The owner specifically wanted context and cost on their own chips, not in the ⋯ menu.

**Messages:**
- User messages are right-aligned bubbles (neutral; faint accent tint in Vivid) with a slightly squared bottom-right
  corner.
- Assistant messages have a small accent-filled model mark on the left, then a muted line with the model name, time and
  cost.
- Markdown is restyled to match. Code blocks get a header showing the language and a Copy button.
- **Hover actions** (copy, regenerate, fork, remember, plus the existing sibling navigation and compare-versions) fade
  and slide in when you hover an assistant message. They're also reachable by keyboard focus.
- **Thinking:** a shimmer sweeps across "Thinking…" (and the reasoning summary line) while waiting. Streaming text ends
  in a blinking accent cursor.
- New messages fade up.
- The error bubble, "no reply" state, context note, file cards and file panel are restyled but behave the same.

### Images, Video, Discussions

No mockups were made. Apply the system:
- the same header pattern, with chips that open existing popovers such as media stats and participants
- the same composer pattern
- generated images and video in a gallery grid with rounded tiles
- the lightbox fading and scaling in
- the discussion transcript styled like the chat conversation, each participant with its own avatar mark

**Tilt is allowed on gallery tiles, not on the transcript.** Keep existing behavior: polling spinners, the "finished"
toast and picking frames.

### Model Library

- A filter row of chips. "My models" and "Browse all" act as a segmented choice; the existing filters become chips.
- The existing sort control.
- A grid of **tilt model cards**, each showing:
  - a provider monogram
  - the name and provider
  - tags (reasoning, vision, context size)
  - price in and out, in mono
  - a footer with "＋ Add", or an accent "✓ Added" / "✓ Default"
- The image and video model libraries use the same cards.

### Stats

- **Stat tiles** become tilt cards.
- **Charts** keep their existing validated data palette. Do not recolor chart series with the accent, because series
  need several distinguishable colors. Chart chrome (axes, gridlines, tooltips) uses the neutral tokens.

### Toasts

- They slide up from the bottom right with a spring.
- Each has a lucide icon, then the text, then a dismiss button.

## Motion

All motion lives in a small shared module of easing and spring constants, adapted from the BeUI component's
`EASE_OUT`, `SPRING_PRESS`, `SPRING_MOUSE` and similar.

- **Press:** buttons and chips scale to about 0.95–0.97 on press, with a spring.
- **Sliding indicators:** the rail marker and segmented-control pills spring between items.
- **Popovers and menus:** scale from their anchor (0.92 → 1) and fade in, about 250–350 ms with a spring.
- **Sheets and the palette:** fade the backdrop, then pop the sheet in (scale 0.96 → 1, rising slightly).
- **Lists:**
  - New messages fade up (8 px, about 500 ms ease-out).
  - Screen changes cross-fade and rise slightly.
  - Thread items nudge on hover.
- **Ambient effects:** the Vivid gradient drift (8 s) and aurora drift (14 s) run on CSS only.
- **Theme and accent switches:** colors transition about 400 ms, so the change feels smooth rather than a hard cut.
- **Tilt cards:** a port of the BeUI `TiltCard`:
  - mouse position drives `rotateX`/`rotateY` through a spring (stiffness 200, damping 15, mass 0.3)
  - maximum tilt is about 12–14° on small cards and about 10° on large ones
  - a radial glare follows the cursor
  - the card springs back to flat on leave
  - only enabled when the device can hover with a fine pointer and motion is allowed
  - in Flat style the glare uses the foreground color; in Vivid it uses the accent

**Switches and reduced motion:**
- The **Animations** switch off: drop all non-essential motion (presses, slides, fades, drift, aurora). Keep instant
  state changes and functional spinners.
- The **Tilt cards** switch off: cards stay flat, with no glare.
- `prefers-reduced-motion: reduce` behaves like both switches off, whatever the settings say.

## Settings data

- Add `accent: 'blue' | 'orange' | 'green' | 'rainbow'` (default `'blue'`) and `colorStyle: 'flat' | 'vivid'`
  (default `'vivid'`) to settings. Store them server-side next to `theme`, with the same validation and errors.
- Add `animations: boolean` and `tiltCards: boolean`, both defaulting to `true`.
- **No flash on load:** the server is the source of truth, but the client caches the last appearance values in
  `localStorage`. A tiny inline script in `index.html` applies `data-theme`, `data-accent`, `data-style` and the
  motion flags before React mounts. *My call:* this is the simplest fix for flashing.
- `data-theme='system'` keeps following the OS live, as today.
- Data export already dumps every settings row except the API key, so the new keys are included automatically. "Delete
  all my data" resets them to their defaults, along with the other settings.

## Technical approach (my calls, the owner can override)

- **Keep the CSS-variable approach and plain CSS.** Rewrite `styles.css` around the new tokens, and split it into a few
  files (tokens, base, layout, components, pages) if it helps. No Tailwind.
- **Add `motion`** (motion.dev, the library the BeUI component uses) for springs, the tilt card and presence
  animations.
- **Add `lucide-react`** for icons, and the Geist font packages.
- **Port `TiltCard` into `web/src/components/TiltCard.tsx`** without the Tailwind helpers (`cn`, `twMerge`). It takes
  `className`, `max` and `glare`, and reads the tilt setting and reduced motion.
- **Reuse the existing `usePopover`** hook for chip popovers. Extend it if anchor-origin animation needs it.
- **Keep the existing hash router.** Only the Settings rendering changes, to an overlay above the last non-settings
  route.

## Suggested build order

Each phase leaves the app working and shippable:
1. **Foundation:**
   - tokens, theme, accent and color-style data attributes
   - settings fields and the no-flash script
   - fonts, lucide icons and the motion constants
   - the base restyle of buttons, inputs, chips and popovers
2. **Shell:** the icon rail, the thread panel, the Settings overlay with the new tabs (Appearance included), and toasts.
3. **Chat:** the home screen with suggestion tilt cards, the composer, the header chips and ⋯ menu, messages, hover
   actions and the thinking shimmer.
4. **Other pages:** Model Library tilt grid, Images, Video, Discussions, Stats.
5. **Command palette.**
6. **Polish pass:**
   - motion tuning
   - checking reduced motion and the switches
   - a light/dark × 4 accents × flat/vivid sweep of every screen
   - narrow-window check

## Left to the builder

- Exact spacing, sizes and minor visual details not specified here. Match the mockup's feel.
- The suggestion cards' starter prompts.
- The greeting copy beyond the time-of-day rule.
- How compare mode's multi-select chip looks, within the composer pattern.
- Whether to split `styles.css`, and how.
- Component boundaries and file structure.
