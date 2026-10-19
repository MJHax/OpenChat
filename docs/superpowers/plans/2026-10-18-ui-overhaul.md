# UI/UX Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle and reorganize OpenChat into a black-and-white "modern AI" UI with one switchable accent (Blue,
Orange, Green or Rainbow), Flat/Vivid color styles, light/dark, an icon rail, a Settings overlay, a command palette,
tilt cards and simple spring animations. Behavior does not change.

**Architecture:**
- Appearance is four new server settings (`accent`, `colorStyle`, `animations`, `tiltCards`) next to `theme`.
- The client mirrors them as `data-*` attributes on `<html>`. Values are cached in `localStorage` and applied by an
  inline script in `index.html` before React mounts, so the theme never flashes.
- All color comes from CSS variables in a new `web/src/styles/` folder: neutrals per theme, `--accent` /
  `--accent-fill` per accent, and Vivid overrides.
- Testable logic lives in pure modules under `web/src/lib/`. UI is verified in the browser.

**Tech Stack:** React 19 + Vite, plain CSS with custom properties, `motion` (motion.dev), `lucide-react`,
`@fontsource-variable/geist` and `@fontsource-variable/geist-mono`, Hono + better-sqlite3 for settings, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-18-ui-overhaul-design.md`. The reference mockup is
`docs/superpowers/specs/2026-10-18-ui-overhaul-mockup.html`. Open it in a browser and copy its CSS values freely.
Where it disagrees with the spec, the spec wins.

## Global Constraints

- **Behavior stays the same.** Only presentation and organization change. Every feature reachable today stays
  reachable in the same number of clicks or fewer. The one exception: turning Compare **on** mid-conversation takes
  two clicks (⋯ → Compare models).
- **Accent is scarce.** It appears only on the spec's list:
  - send and primary buttons
  - the logo mark
  - the active rail marker and active thread bar
  - the active rail icon
  - focus glow
  - selected states
  - the greeting highlight
  - the busy dot
  - progress bars and rings
  - the streaming cursor

  It never appears on large surfaces or body text.
- **Never tilt** chat messages, menus, popovers or forms. Tilt is only for suggestion cards, model cards, gallery tiles
  and stat tiles.
- **Motion limits:** no animation over about 500 ms on an interaction path, and nothing may delay input.
  `prefers-reduced-motion: reduce` behaves like both Motion switches off.
- **Neutral tokens:**

  | Token | Dark | Light |
  |---|---|---|
  | `--bg` | `#0a0a0a` | `#ffffff` |
  | `--panel` | `#0f0f0f` | `#fafafa` |
  | `--surface` | `#151515` | `#ffffff` |
  | `--surface-2` | `#1c1c1c` | `#f4f4f5` |
  | `--border` | `#242424` | `#e7e7e7` |
  | `--border-strong` | `#333333` | `#d4d4d4` |
  | `--text` | `#fafafa` | `#0a0a0a` |
  | `--muted` | `#8f8f8f` | `#6b6b6b` |
  | `--faint` | `#5a5a5a` | `#a3a3a3` |

- **Accents:**

  | Accent | Solid | Vivid duotone stops |
  |---|---|---|
  | Blue | `#3b82f6` | `#2563eb, #3b82f6, #22d3ee, #6366f1` |
  | Orange | `#f97316` | `#ea580c, #f97316, #f59e0b, #f43f5e` |
  | Green | `#22c55e` (`#16a34a` in light mode) | `#16a34a, #22c55e, #a3e635, #14b8a6` |
  | Rainbow | `#8b5cf6` | `#ff5f6d, #ffc371, #47e891, #3bb2ff, #a066ff`, always vivid |

- **Easing:**
  - ease-out: `cubic-bezier(0.16, 1, 0.3, 1)`
  - spring: `cubic-bezier(0.34, 1.56, 0.64, 1)`
  - tilt spring: stiffness 200, damping 15, mass 0.3
- **Vivid timings:**
  - the gradient drifts over 8 s (`background-size: 300%`)
  - the aurora drifts over 14 s, at opacity 0.13 in dark mode and 0.09 in light mode
- **Dependencies:** the only new runtime dependencies are `motion`, `lucide-react`, `@fontsource-variable/geist` and
  `@fontsource-variable/geist-mono`. No Tailwind, no shadcn, and no Google Fonts at runtime.
- **Code conventions:**
  - Keep each file's existing line endings (LF).
  - Wrap every `localStorage` access in try/catch, as `web/src/lib/effort.ts` does.
  - Keys start with `openchat.`, so "Delete all my data" (`forgetAllPrefs`) clears them.
- **Commits:**
  - style: `feat(web): …` / `feat(server): …` / `test(web): …`
  - every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  - work on branch `ui-overhaul`
- **Verification:**
  - Never touch the user's server on port 3000. Start the dev server with `OPENCHAT_PORT` set to another port
    (e.g. 3100).
  - No paid model calls are needed. Don't send chat messages during verification.
- **Done for every task:**
  - `npx vitest run` and `npx tsc --noEmit` pass
  - UI tasks are checked in the browser in dark and light mode, with at least Blue Flat and Rainbow
  - the work is committed

## Review Focus

1. **Corrupt or stale appearance cache** (bad JSON, an unknown accent, an old shape in `openchat.appearance`). Load
   falls back to defaults without throwing, then the server value overwrites it. *(Task 2: `parseAppearance` tests.)*
2. **Theme is System and the OS flips light/dark while the app is open.** `data-theme` follows live. The rail toggle
   then picks the opposite of what is *showing*, not of the stored value. *(Task 2: `nextTheme` tests; Task 6 browser
   check.)*
3. **Old deep links** (`#/settings/general/limits`, `#/settings/general`, `#/settings/bogus`) and links typed while
   Settings is open. They land on the right tab, and closing returns to the page behind. *(Task 5: `parseHash` and
   `settingsBackdrop` tests.)*
4. **Rainbow selected, then Flat chosen** (via the command palette, or a stale setting). Rainbow still renders vivid.
   The Flat card is disabled but the stored value is kept. *(Task 3: CSS rule; Task 7 browser check; Task 2:
   `effectiveStyle` test.)*
5. **The command palette query matches nothing, or search errors.** The palette shows "No results" for commands and
   a muted error for chats, and never closes or throws. Arrow keys clamp, and Enter on nothing does nothing. *(Task
   13: `filterCommands` / `moveSelection` tests.)*

---

## File map

| File | Responsibility |
|---|---|
| `shared/types.ts` (modify) | `Accent`, `ColorStyle` types; `SettingsView` and `SettingsUpdate` gain `accent`, `colorStyle`, `animations`, `tiltCards` |
| `server/src/settings.ts` (modify) | Defaults, validation and storage for the four new settings |
| `shared/limits.ts` (modify) | `SPENDING_LIMITS_HREF` becomes `'#/settings/limits'` |
| `web/index.html` (modify) | Inline no-flash script |
| `web/src/lib/appearance.ts` (create) | Pure appearance helpers plus cache read/write |
| `web/src/lib/greeting.ts` (create) | `greeting(hour)` |
| `web/src/lib/motion.ts` (create) | Easing and spring constants, `tiltFromPointer` |
| `web/src/lib/route.ts` (modify) | New settings tabs, legacy-link mapping, settings backdrop |
| `web/src/lib/palette.ts` (create) | Command palette items, filtering, selection |
| `web/src/styles/tokens.css` (create) | Neutrals, accents, Vivid, aurora |
| `web/src/styles/base.css` (create) | Reset, type, buttons, inputs, chips, popovers, press, reduced-motion |
| `web/src/styles/shell.css` (create) | Rail, thread panel, settings sheet, palette, toasts |
| `web/src/styles/chat.css` (create) | Home, composer, header chips, messages, code, thinking |
| `web/src/styles/pages.css` (create) | Library, images, video, discussions, stats |
| `web/src/styles.css` (delete) | Replaced by `web/src/styles/*`; every existing rule is ported into the new files |
| `web/src/components/TiltCard.tsx` (create) | Port of BeUI TiltCard |
| `web/src/components/useAppearance.ts` (create) | Hook that applies settings to `<html>`, plus the motion flags |
| `web/src/components/shell/IconRail.tsx` (create) | Rail |
| `web/src/components/shell/ThreadPanel.tsx` (create) | Replaces `Sidebar.tsx`'s list UI (logic moves over) |
| `web/src/components/shell/UsageCard.tsx` (create) | Spend card |
| `web/src/components/shell/CommandPalette.tsx` (create) | Ctrl/Cmd+K palette |
| `web/src/components/Sidebar.tsx` (delete) | `threadHref` moves to `web/src/lib/route.ts` |
| `web/src/components/ChipPopover.tsx` (create) | Chip trigger plus an anchored popover using `usePopover` |
| `web/src/components/ModelPicker.tsx` (create) | Model chip plus popover; multi-select in compare mode |
| `web/src/components/ChatMenu.tsx` (create) | ⋯ menu: Chat instructions, Compare models |
| `web/src/components/ChatHome.tsx` (create) | Greeting plus suggestion cards |
| `web/src/pages/Settings.tsx` (modify) | Becomes an overlay sheet with five tabs |
| `web/src/pages/settings/AppearanceTab.tsx` (create) | Theme, accent, color style, motion |
| `web/src/pages/settings/LimitsTab.tsx` (create) | Wraps the existing `SpendingLimitsSection` |
| Everything else under `web/src` | Restyled in place; logic untouched |

---

### Task 1: Appearance settings on the server

**Files:**
- Modify: `shared/types.ts`, `server/src/settings.ts`
- Test: `server/test/settings.test.ts`, `server/test/settingsRoutes.test.ts`

**Interfaces:**
- Produces:
  - `type Accent = 'blue' | 'orange' | 'green' | 'rainbow'`
  - `type ColorStyle = 'flat' | 'vivid'`
  - `ACCENTS: Accent[]` and `COLOR_STYLES: ColorStyle[]`, exported from `shared/types.ts`
  - `SettingsView` gains `accent: Accent; colorStyle: ColorStyle; animations: boolean; tiltCards: boolean`
  - `SettingsUpdate` gains the same fields, all optional

- [ ] **Step 1: Write failing tests in `server/test/settings.test.ts`**

```ts
describe('appearance settings', () => {
  it('defaults to blue, vivid, animations and tilt on', () => {
    const db = openDb(':memory:');
    expect(getSettingsView(db, {})).toMatchObject({ accent: 'blue', colorStyle: 'vivid', animations: true, tiltCards: true });
  });
  it('saves and reads them back', () => {
    const db = openDb(':memory:');
    updateSettings(db, { accent: 'rainbow', colorStyle: 'flat', animations: false, tiltCards: false });
    expect(getSettingsView(db, {})).toMatchObject({ accent: 'rainbow', colorStyle: 'flat', animations: false, tiltCards: false });
  });
  it('rejects bad values', () => {
    const db = openDb(':memory:');
    expect(() => updateSettings(db, { accent: 'pink' as never })).toThrow(HttpError);
    expect(() => updateSettings(db, { colorStyle: 'loud' as never })).toThrow(HttpError);
    expect(() => updateSettings(db, { animations: 'yes' as never })).toThrow(HttpError);
  });
});
```

Add a route test in `settingsRoutes.test.ts`, following that file's pattern. `PUT /api/settings` with
`{ accent: 'green' }` returns a view with `accent: 'green'`, and `{ accent: 'x' }` returns 400.

- [ ] **Step 2: Run `npx vitest run server/test/settings.test.ts server/test/settingsRoutes.test.ts`.** Expected: the
  new tests FAIL.
- [ ] **Step 3: Implement.**
  - Add `accent: 'blue'`, `color_style: 'vivid'`, `animations: '1'` and `tilt_cards: '1'` to `DEFAULTS`.
  - Add `accent` and `colorStyle` to `UPDATE_KEYS`. Validate them against `ACCENTS` / `COLOR_STYLES` with 400 errors:
    - "Accent must be blue, orange, green, or rainbow."
    - "Color style must be flat or vivid."
  - Handle the booleans before the string loop:
    - reject non-booleans with "animations must be true or false." (and the same wording for tiltCards)
    - store them as `'1'` / `'0'`
  - Exclude both booleans from `UPDATE_KEYS`' type.
- [ ] **Step 4: Run the same tests.** Expected: PASS. Then run `npx tsc --noEmit`. Expected: no errors.
- [ ] **Step 5: Commit** with `feat(server): accent, color style and motion settings`.

### Task 2: Client appearance logic and no-flash boot

**Files:**
- Create: `web/src/lib/appearance.ts`, `web/src/lib/appearance.test.ts`, `web/src/components/useAppearance.ts`
- Modify: `web/index.html`, `web/src/App.tsx` (replace the `data-theme` effect at lines ~77-79)

**Interfaces:**
- Consumes: Task 1 types.
- Produces (from `web/src/lib/appearance.ts`):
  - `interface Appearance { theme: Theme; accent: Accent; colorStyle: ColorStyle; animations: boolean; tiltCards: boolean }`
  - `const APPEARANCE_KEY = 'openchat.appearance'`
  - `const DEFAULT_APPEARANCE: Appearance`, which is system, blue, vivid, true, true
  - `parseAppearance(raw: string | null): Appearance`. It merges valid fields over the defaults and never throws.
  - `loadAppearance(): Appearance` and `saveAppearance(a: Appearance): void`, both wrapped in try/catch
  - `effectiveStyle(a: Pick<Appearance, 'accent' | 'colorStyle'>): ColorStyle`. Returns `'vivid'` when the accent is
    rainbow.
  - `resolvedTheme(theme: Theme, systemDark: boolean): 'light' | 'dark'`
  - `nextTheme(theme: Theme, systemDark: boolean): 'light' | 'dark'`. The opposite of what is showing.
  - `htmlAttrs(a: Appearance, systemDark: boolean, reducedMotion: boolean): Record<string, string>`. Returns
    `{ theme, accent, style, motion: 'on' | 'off', tilt: 'on' | 'off' }`:
    - `theme` is resolved
    - `style` comes from `effectiveStyle`
    - `motion` is `'off'` when animations are off **or** `reducedMotion` is true
    - `tilt` is `'off'` when tiltCards are off **or** `reducedMotion` is true
- Produces (from `web/src/components/useAppearance.ts`):
  - `useAppearance(settings: SettingsView | null): { appearance: Appearance; setAppearance(patch: Partial<Appearance>): Promise<void>; motionOn: boolean; tiltOn: boolean }`
  - It writes `htmlAttrs` to `document.documentElement.dataset` whenever the inputs change, and listens to
    `matchMedia('(prefers-color-scheme: dark)')` and `('(prefers-reduced-motion: reduce)')`.
  - When the server settings arrive it calls `saveAppearance`.
  - `setAppearance` updates the attributes optimistically, then calls `api.updateSettings(patch)`. On failure it
    rolls back.

- [ ] **Step 1: Write failing tests in `appearance.test.ts`.** Cover:
  - `parseAppearance(null)`, `('not json')`, `('{"accent":"pink","colorStyle":"flat"}')` and `('[1]')`:
    - pink falls back to blue while flat is kept
    - the array input yields the defaults
  - `effectiveStyle({ accent: 'rainbow', colorStyle: 'flat' })` returns `'vivid'`, and green/flat returns `'flat'`.
  - `nextTheme('system', true)` returns `'light'`, `nextTheme('system', false)` returns `'dark'`, and
    `nextTheme('dark', false)` returns `'light'`.
  - `htmlAttrs({...DEFAULT_APPEARANCE, animations: true}, false, true)` has `motion: 'off'` and `tilt: 'off'`.
  - `htmlAttrs(DEFAULT_APPEARANCE, true, false)` returns
    `{ theme: 'dark', accent: 'blue', style: 'vivid', motion: 'on', tilt: 'on' }`.
- [ ] **Step 2: Run `npx vitest run web/src/lib/appearance.test.ts`.** Expected: FAIL (module missing).
- [ ] **Step 3: Implement `appearance.ts` and `useAppearance.ts`.** Then add the inline script to `index.html`'s
  `<head>`. It must:
  - read `localStorage['openchat.appearance']` in a try/catch
  - apply the same five `data-*` attributes with the same rules as `htmlAttrs`
  - duplicate the logic (≈15 lines, plain ES5), because it can't import modules
  - fall back to `data-theme` from `prefers-color-scheme`, `blue` and `vivid` when nothing is stored

  In `App.tsx`, call `useAppearance(settings)` and pass `appearance` / `setAppearance` down where Tasks 6, 7 and 13
  need them.
- [ ] **Step 4: Run the tests again.** Expected: PASS. Run `npx tsc --noEmit`. Expected: clean.
- [ ] **Step 5: Check in the browser.**
  1. Set the accent to orange through `PUT /api/settings` (curl against your verification port).
  2. Reload. `document.documentElement.dataset.accent` is `'orange'` in the first frame, before React mounts (check
     with a `<script>` breakpoint or by reading `dataset` in `index.html` order).
- [ ] **Step 6: Commit** with `feat(web): appearance state and no-flash boot`.

### Task 3: Design tokens, base styles, fonts and icons

**Files:**
- Create: `web/src/styles/tokens.css`, `base.css`, `shell.css`, `chat.css`, `pages.css`
- Create: `web/src/lib/motion.ts`, `web/src/lib/motion.test.ts`
- Delete: `web/src/styles.css`
- Modify: `web/src/main.tsx` (imports), `package.json`, and every component that renders a Unicode or emoji icon

**Interfaces:**
- Produces (`web/src/lib/motion.ts`):
  - `EASE_OUT = [0.16, 1, 0.3, 1] as const` and `EASE_SPRING_CSS = 'cubic-bezier(0.34, 1.56, 0.64, 1)'`
  - `SPRING_PRESS = { type: 'spring', stiffness: 500, damping: 30, mass: 0.6 } as const`
  - `SPRING_PANEL = { type: 'spring', stiffness: 420, damping: 40, mass: 0.5 } as const`
  - `SPRING_MOUSE = { stiffness: 200, damping: 15, mass: 0.3 } as const`
  - `tiltFromPointer(px: number, py: number, max: number): { rx: number; ry: number; gx: number; gy: number }`
    - `px` and `py` are 0–1 within the element
    - `ry = (px - 0.5) * max`, `rx = (0.5 - py) * max`, `gx = px * 100`, `gy = py * 100`
    - clamp `px` and `py` to 0–1
- Produces (CSS, used by every later task):
  - Tokens:
    - the neutral tokens from Global Constraints
    - `--accent`, `--accent-fill`, `--on-accent`, `--glow-a`, `--glow-b`, `--glare-c`
    - `--ease-out`, `--ease-spring`
    - a `--radius-sm` / `--radius` / `--radius-lg` scale of 8 / 12 / 20 px
  - Utility classes:
    - `.fill`: paints `--accent-fill` and drifts when vivid
    - `.press`: a spring scale of 0.96 on `:active`
    - `.chip`, `.chip.ghost`, `.icon-btn`, `.popover` (+ `.open`), `.seg` + `.pill`, `.switch` (+ `.on`)
    - `.aurora`: an absolutely positioned glow layer
  - Selectors key off `html[data-theme]`, `[data-accent]`, `[data-style]`, `[data-motion='off']` and
    `[data-tilt='off']`.
  - `[data-motion='off'] *` disables animations and transitions, except `.spinner`.

- [ ] **Step 1: Write a failing `motion.test.ts`.**
  - `tiltFromPointer(0.5, 0.5, 12)` returns `{ rx: 0, ry: 0, gx: 50, gy: 50 }`
  - `(1, 0, 12)` returns `{ rx: 6, ry: 6, gx: 100, gy: 0 }`
  - `(1.4, -0.2, 10)` clamps to `{ rx: 5, ry: 5, gx: 100, gy: 0 }`
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement `motion.ts`.** Run `npm i motion lucide-react @fontsource-variable/geist @fontsource-variable/geist-mono`.
- [ ] **Step 4: Port all of `styles.css` into the five new files.**
  - Sort by section: tokens and base, then sidebar/settings/toasts into shell, chat/composer/compare into chat, and
    the rest into pages.
  - Swap the old palette variables for the new tokens (`--accent` keeps its name; `--sidebar` becomes `--panel`;
    `--hover` becomes `--surface-2`; `--user-bubble` becomes `--bubble`).
  - Keep the context-popover dataviz series colors exactly as they are.
  - Keep `--danger` and `--warn` semantic, using the existing values, not tied to the accent.
  - Code blocks stay dark in both modes (`--code-bg`).
  - Set `body { font-family: 'Geist Variable', system-ui, sans-serif }` and mono to `'Geist Mono Variable'`.
  - Import the fontsource packages and the five CSS files in `main.tsx`, in the order tokens, base, shell, chat,
    pages, after the highlight.js theme.
  - Delete `styles.css`.
  - Copy the mockup's Vivid block (duotone fills, aurora, `--glare-c`, the drift and aurora keyframes) into
    `tokens.css`, with the values from Global Constraints.
- [ ] **Step 5: Replace every Unicode or emoji icon with `lucide-react`.**
  - Find them with `grep -rnP "[\x{2190}-\x{2BFF}\x{1F300}-\x{1FAFF}\x{FF0B}]" web/src --include=*.tsx`. Leave
    non-icon text (arrows inside prose, `«»` snippet markers) alone.
  - Use size 16 in buttons and 14 in chips.
  - Mapping: ✕ → `X`, ＋ → `Plus`, ☰ / ⟨ → `PanelLeft`, 🎬 → `Clapperboard`. Pick the closest lucide icon for the
    rest.
- [ ] **Step 6: Run `npx tsc --noEmit` and `npx vitest run`.** Expected: PASS.
- [ ] **Step 7: Check in the browser.** Start the dev server on a non-3000 server port, then for each accent in dark
  and light mode, plus Rainbow, toggle `dataset.style` between flat and vivid through the console. Confirm:
  - every existing page renders with no unstyled regions
  - no console errors
  - code blocks stay dark
  - the serif font is gone
- [ ] **Step 8: Commit** with `feat(web): new design tokens, fonts and icons`.

### Task 4: TiltCard

**Files:**
- Create: `web/src/components/TiltCard.tsx`

**Interfaces:**
- Consumes: `tiltFromPointer` and `SPRING_MOUSE` (Task 3), and the `data-tilt` attribute (Task 2).
- Produces:
  - `TiltCard({ children, className, max = 12, glare = true, as = 'div', ...rest }: { children: ReactNode; className?: string; max?: number; glare?: boolean; as?: 'div' | 'button' | 'a' } & HTMLAttributes<HTMLElement>)`
  - It renders `motion[as]` with class `tilt` and passes `rest` through (onClick, href, aria).
  - The glare is a child `.glare` with background
    `radial-gradient(circle at gx% gy%, var(--glare-c, var(--glare)), transparent 50%)`. Its opacity comes from CSS
    (0.12 in dark mode, 0.06 in light mode).
  - Tilt is enabled only when `matchMedia('(hover: hover) and (pointer: fine)')` matches **and**
    `document.documentElement.dataset.tilt !== 'off'`. Read both on mouse enter, so toggling needs no re-render.
  - Mouse leave resets to 0.

- [ ] **Step 1: Implement `TiltCard.tsx`.** Port the BeUI component given in the spec's conversation: `useMotionValue`
  + `useSpring(SPRING_MOUSE)` + `useMotionTemplate`, without `cn` / `twMerge`.
- [ ] **Step 2: Run `npx tsc --noEmit`.** Expected: clean.
- [ ] **Step 3: Check in the browser.** Temporarily render one `TiltCard` (in Task 8's place, or a scratch route you
  then remove). Confirm:
  - it tilts and the glare follows the cursor
  - with `dataset.tilt = 'off'` it stays flat with no glare
- [ ] **Step 4: Commit** with `feat(web): TiltCard`.

### Task 5: Routes for the new Settings tabs and the overlay

**Files:**
- Modify: `web/src/lib/route.ts`, `web/src/lib/route.test.ts`, `shared/limits.ts`

**Interfaces:**
- Produces:
  - `type SettingsTab = 'general' | 'appearance' | 'memory' | 'data' | 'limits'`
  - `parseHash` maps the legacy `#/settings/general/limits` to `{ page: 'settings', tab: 'limits', section: null }`.
    All other existing mappings are unchanged.
  - `settingsBackdrop(prev: Route | null): Route`. This is the page Settings renders over: `prev` if it is non-null
    and not a settings route, else `{ page: 'chat', chatId: null }`.
  - `threadHref(kind: ThreadKind, id: string): string`, moved here from `Sidebar.tsx`
  - `SPENDING_LIMITS_HREF = '#/settings/limits'`

- [ ] **Step 1: Add failing tests to `route.test.ts`.**
  - `parseHash('#/settings/appearance')` returns tab `'appearance'`.
  - `parseHash('#/settings/limits')` returns tab `'limits'`.
  - `parseHash('#/settings/general/limits')` returns `{ page: 'settings', tab: 'limits', section: null }`.
  - Update the existing assertion that expected `tab: 'general', section: 'limits'`.
  - `settingsBackdrop(null)` returns the chat home.
  - `settingsBackdrop({ page: 'settings', tab: 'data', section: null })` returns the chat home.
  - `settingsBackdrop({ page: 'models' })` returns `{ page: 'models' }`.
- [ ] **Step 2: Run `npx vitest run web/src/lib/route.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement.** Update `threadHref` imports in `App.tsx`. `Sidebar.tsx` stays until Task 6.
- [ ] **Step 4: Run all tests and `npx tsc --noEmit`.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat(web): settings tabs for appearance and limits`.

### Task 6: Shell — icon rail, thread panel, usage card and toasts

**Files:**
- Create: `web/src/components/shell/IconRail.tsx`, `ThreadPanel.tsx`, `UsageCard.tsx`
- Delete: `web/src/components/Sidebar.tsx`
- Modify: `web/src/App.tsx`, `web/src/styles/shell.css`

**Interfaces:**
- Consumes: `useAppearance` (Task 2), `nextTheme` (Task 2), `threadHref` (Task 5).
- Produces:
  - `IconRail({ active, onToggleTheme, resolvedTheme, panelOpen, onTogglePanel }: { active: 'chat' | 'image' | 'video' | 'discussion' | 'models' | 'stats' | 'settings'; onToggleTheme(): void; resolvedTheme: 'light' | 'dark'; panelOpen: boolean; onTogglePanel(): void })`
  - `ThreadPanel` takes Sidebar's old props `{ mode, chats, activeChatId, onChatsChanged, onOpenChat }` plus
    `{ onCollapse(): void; onOpenPalette(): void }`.
  - `UsageCard()` takes no props and loads its own data.

- [ ] **Step 1: Build `IconRail`.**
  - Order: logo (`.fill`); Chats, Images, Video, Discussions; divider; Model Library, Stats; spacer; theme toggle
    (shows `Sun` in dark mode, `Moon` in light mode); Settings.
  - Hover tooltips.
  - A single absolutely positioned indicator, moved to the active button's `offsetTop` with a `top` transition on
    `--ease-spring` (0.5 s), plus a 3 px `.fill` bar.
  - Clicking the active **mode** icon calls `onTogglePanel`.
  - Settings navigates to `#/settings/<last tab or general>`.
- [ ] **Step 2: Build `ThreadPanel`.**
  - Move the list, rename, delete, date-group and search-hit logic over from `Sidebar.tsx` unchanged.
  - Header: mode name plus a ＋ button (`NEW_LABEL` as the title) plus a collapse `PanelLeftClose` button.
  - The search field becomes a button styled as an input ("Search or jump to…" with a `Ctrl K` kbd) that calls
    `onOpenPalette`. Sidebar search moves into the palette (Task 13). Until Task 13 lands, keep the current inline
    search behind it.
  - Active item gets a 2 px `.fill` bar.
  - Busy item gets a pulsing `.fill` dot in place of the spinner.
- [ ] **Step 3: Build `UsageCard`.**
  - Call `api.limits()`. If a `monthly` status exists, show "This month", then `$spent / $amount`, then a `.fill` bar
    at `spent/amount`, capped at 100%.
  - Otherwise call `api.stats('month', Intl.DateTimeFormat().resolvedOptions().timeZone)` and show "Last 30 days"
    with `$allSpend` and no bar. *My call:* the API has no calendar-month spend without a limit, and the spec rules
    out new endpoints.
  - Format money with the existing helper in `web/src/lib/format.ts` or `stats.ts`.
  - Refetch when `chats` change.
- [ ] **Step 4: Wire up `App.tsx`.**
  - Layout: `grid-template-columns: 60px var(--panel-w, 260px) 1fr`. Collapsed sets `--panel-w: 0`, with a 0.35 s
    `--ease-out` transition.
  - Ctrl/Cmd+B toggles the panel.
  - Below 900 px (`matchMedia('(max-width: 899px)')`), the panel starts collapsed and opens as an overlay above main.
  - Toasts: bottom-right, spring slide-up, a lucide icon, text, then an `X`.
- [ ] **Step 5: Run `npx tsc --noEmit` and `npx vitest run`.** Expected: PASS.
- [ ] **Step 6: Check in the browser.**
  - The rail indicator slides between items.
  - Switching modes swaps the list.
  - Rename and delete still work.
  - Collapse works via the button, the active rail icon and Ctrl+B.
  - The theme toggle flips the mode, including from System.
  - At 800 px width there's no horizontal scroll.
  - The usage card shows either variant (set a monthly limit to see the bar).
- [ ] **Step 7: Commit** with `feat(web): icon rail and thread panel`.

### Task 7: Settings overlay, Appearance tab and Spending limits tab

**Files:**
- Create: `web/src/pages/settings/AppearanceTab.tsx`, `web/src/pages/settings/LimitsTab.tsx`
- Modify: `web/src/pages/Settings.tsx`, `web/src/pages/settings/GeneralTab.tsx` (remove Theme and the limits
  section), `web/src/App.tsx`

**Interfaces:**
- Consumes: `settingsBackdrop` (Task 5), and `appearance` / `setAppearance` (Task 2).
- Produces: `Settings` gains `onClose(): void`. `AppearanceTab({ appearance, onChange }: { appearance: Appearance; onChange(patch: Partial<Appearance>): void })`.

- [ ] **Step 1: Make `App.tsx` remember the last non-settings route.** Use a ref updated on each route change. When
  `route.page === 'settings'`, render `settingsBackdrop(last)`'s page underneath, then the `Settings` overlay.
  `onClose` navigates back to the backdrop's hash (build it from the route).
- [ ] **Step 2: Build the `Settings` sheet.**
  - A backdrop with `blur(6px)` and a 0.3 s fade.
  - A sheet popping from scale 0.96, with tabs on the left (General, Appearance, Memory, Data, Spending limits) using
    lucide icons.
  - Escape, ✕ and a backdrop click close it.
  - Focus moves into the sheet on open and returns on close.
- [ ] **Step 3: Build `AppearanceTab`.** Mirror the mockup's Settings pane:
  - **Theme:** three preview cards (Light, Dark, System).
  - **Accent:** four swatches, with a check that springs in.
  - **Color style:** Flat and Vivid preview cards.
    - With Rainbow selected, the section has opacity 0.45 and is non-interactive.
    - The hint reads "How much the accent shows up. Rainbow is always vivid."
  - **Motion:** "Animations" and "Tilt cards" switches.

  Every change calls `onChange` and applies instantly.
- [ ] **Step 4: `LimitsTab` renders the existing `SpendingLimitsSection`.** Remove Theme and the limits section from
  `GeneralTab`.
- [ ] **Step 5: Run `npx tsc --noEmit` and `npx vitest run`.** Expected: PASS.
- [ ] **Step 6: Check in the browser.**
  - Open Settings from a chat. The chat stays visible and blurred behind it.
  - Escape returns to the same chat.
  - `#/settings/general/limits` lands on Spending limits.
  - The spend-notice "Limits" link works.
  - Every appearance control changes the app live, and the change survives a reload with no flash.
  - With Rainbow selected, the Flat card is disabled.
- [ ] **Step 7: Commit** with `feat(web): settings overlay with appearance and limits tabs`.

### Task 8: Chat home and the composer

**Files:**
- Create: `web/src/components/ChatHome.tsx`, `web/src/components/ModelPicker.tsx`, `web/src/components/ChipPopover.tsx`
- Create: `web/src/components/ChatMenu.tsx`, `web/src/lib/greeting.ts`, `web/src/lib/greeting.test.ts`
- Modify: `web/src/components/Composer.tsx`, `web/src/components/ChatView.tsx` (the empty state at ~442 and the header
  at ~420-432), `web/src/styles/chat.css`

**Interfaces:**
- Consumes: `TiltCard` (Task 4).
- Produces:
  - `greeting(hour: number): 'Good morning.' | 'Good afternoon.' | 'Good evening.'`
    - 5–11 → morning
    - 12–17 → afternoon
    - otherwise → evening
  - `ChipPopover({ label, icon, title, align = 'left', children }: { label: ReactNode; icon?: ReactNode; title: string; align?: 'left' | 'right'; children: ReactNode })`
    - built on `usePopover`
    - the popover scales from its anchor corner (0.92 → 1, 0.35 s `--ease-spring`)
  - `ModelPicker({ models, modelId, onModelChange, compare, onCompareChange }: { models: LibraryModel[]; modelId: string; onModelChange(id: string): void; compare: CompareState; onCompareChange(next: CompareState): void })`
    - **Single mode:** the chip shows an accent dot and the display name. Its popover lists models with prices and
      context sizes from `LibraryModel`, with a check on the selected one.
    - **Compare mode:** the chip shows the chosen names, joined, or "N models". The popover holds checkboxes using
      `toggleModel` and respects `MAX_COMPARE`. An `X` inside the chip calls
      `onCompareChange({ ...compare, enabled: false })`.
  - `ChatMenu({ instructions, onSaveInstructions, compare, onCompareChange, canCompare }: { instructions: string; onSaveInstructions(v: string): Promise<void> | void; compare: CompareState; onCompareChange(next: CompareState): void; canCompare: boolean })`
    - a `MoreHorizontal` icon button
    - items: "Chat instructions", which opens the existing `InstructionsButton` editor (refactor it to accept an
      `open` / `onOpenChange` pair, or render its panel), and "Compare models", which shows a check when on and is
      disabled when `!canCompare`
  - `Composer` gains `showCompareToggle: boolean` and `prefill?: { text: string; nonce: number }`. A new `nonce` sets
    the textarea to `text` and focuses it.

- [ ] **Step 1: Write a failing `greeting.test.ts`** covering hours 4, 5, 11, 12, 17, 18 and 23 → evening, morning,
  morning, afternoon, afternoon, evening, evening.
- [ ] **Step 2: Run it.** Expected: FAIL. Implement it, then run again. Expected: PASS.
- [ ] **Step 3: Restyle `Composer`.**
  - A rounded box (`--radius-lg`): textarea on top, then the row.
  - Row order: attach, web search (an icon toggle with `Globe`), compare (a `Columns2` icon toggle, only when
    `showCompareToggle`), `ModelPicker`, the effort chip (keep the `<select>` logic, styled as a chip, still shown only
    when `replyModels.some(m => m.supportsReasoning)`), a spacer, then send (`.fill`, `ArrowUp`) or stop (`Square`).
  - Focus-within ring: `0 0 0 4px` accent at 14% plus a soft accent glow.
  - Keep every hint, notice and attachment behavior.
- [ ] **Step 4: Build `ChatHome`, shown when `!chatId && !pending`.**
  - The greeting from `greeting(new Date().getHours())`, plus `<em>` "What's next?" painted with `--accent-fill`
    (background-clip text).
  - The subtitle "Ask anything, generate images or video, or set two models talking."
  - The composer.
  - Four tilt cards in a row:
    - Write: prefill "Help me write "
    - Code: prefill "Help me debug this code:\n\n"
    - Imagine: navigate `#/images`
    - Discuss: navigate `#/discussions`

    Prefill needs a `prefill` prop on `Composer` that sets the text and focuses.
  - The setup hints replace the cards when there's no key or no models.
- [ ] **Step 5: Header on home and conversation.**
  - Home: the title area is empty, then `ChatMenu` on the right. `canCompare = models.length >= 2`.
  - The composer gets `showCompareToggle={!chatId}`.
  - The draft instructions flow stays as today (`draftInstructions`).
- [ ] **Step 6: Run `npx tsc --noEmit` and `npx vitest run`.** Expected: PASS.
- [ ] **Step 7: Check in the browser on the Chat home.**
  - The greeting and cards render, and the cards tilt.
  - The model picker opens with a spring and selects.
  - The compare toggle turns the picker multi-select, and its `X` turns compare off.
  - ⋯ → Compare models toggles too.
  - ⋯ → Chat instructions edits draft instructions.
  - The composer focus glow shows.
- [ ] **Step 8: Commit** with `feat(web): chat home, composer and model picker`.

### Task 9: Chat conversation

**Files:**
- Modify: `web/src/components/ChatView.tsx`, `MessageItem.tsx`, `MessageBody.tsx`, `Markdown.tsx`,
  `ThinkingIndicator.tsx`, `ContextPopover.tsx`, `ChatStatsPopover.tsx`, `web/src/styles/chat.css`

**Interfaces:**
- Consumes: `ChipPopover`, `ChatMenu` (Task 8).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Header**, left to right:
  1. The title.
  2. The context chip: a 13 px conic ring (`--p` = percent, `--accent` fill) plus "{n}% context". It opens the
     existing `ContextPopover` content. Restyle its trigger into a chip; keep its content and the Summarize &
     continue action.
  3. The cost chip: `BarChart3` icon plus the existing total. It opens the existing `ChatStatsPopover` content.
  4. `ChatMenu`, the same as on home.

  The composer gets `showCompareToggle={false}` once a chat exists.
- [ ] **Step 2: Messages.**
  - User bubble: `--bubble`, a 1 px border, radius `18px 18px 6px 18px`. In Vivid it gets an accent tint via
    `color-mix(… 9%)`.
  - Assistant: a 26 px `.fill` mark with the model's first letter, then a muted line with the model name, time and
    cost (the existing meta), then the body.
  - Hover actions (copy, regenerate, fork, remember, sibling nav, compare versions) sit in a row with
    `opacity: 0; translateY(-3px)`. They show on `:hover` and `:focus-within`, with a 0.25 s transition.
  - New messages get a `rise` animation (8 px, 0.5 s `--ease-out`). Apply it only to messages that mount after the
    first render, so a long chat doesn't animate everything on open.
- [ ] **Step 3: Code blocks.** A header bar with the language on the left and Copy on the right. Keep the existing
  copy and file actions. Use the mono font.
- [ ] **Step 4: Thinking and streaming.**
  - `ThinkingIndicator` text gets the shimmer: a gradient text sweep over 2.2 s, from `--faint` to `--text`.
  - The streaming tail gets a blinking 8×16 `.fill` cursor (1 s, `steps(2)`).
- [ ] **Step 5: Restyle the rest.** The error bubble, no-reply, context note, file cards, file panel, compare columns,
  sources and spend notice, all on the new tokens with behavior unchanged.
- [ ] **Step 6: Run `npx tsc --noEmit` and `npx vitest run`.** Expected: PASS.
- [ ] **Step 7: Check in the browser, opening an existing chat** (no sending).
  - The chips open their popovers.
  - The ⋯ menu has exactly two items.
  - Hover actions appear and work: copy, fork and sibling nav.
  - Code blocks look right.
  - Opening a long chat doesn't animate every message.
- [ ] **Step 8: Commit** with `feat(web): restyled chat conversation`.

### Task 10: Model libraries

**Files:**
- Modify: `web/src/pages/ModelLibrary.tsx`, `web/src/components/ModelCard.tsx`, `CatalogFilters.tsx`,
  `PopularShelf.tsx`, `LibraryHeading.tsx`, `ImageModelLibrary.tsx`, `VideoModelLibrary.tsx`, `web/src/styles/pages.css`

**Interfaces:**
- Consumes: `TiltCard` (Task 4).

- [ ] **Step 1: Restyle `ModelCard` as a `TiltCard` with `max={10}`.**
  - A 34 px provider monogram tile (first letter of the provider), then the name and provider.
  - Tag chips (reasoning, vision, context size) from the fields the card already reads.
  - Price in and out in mono.
  - Footer: "＋ Add" (a ghost button), or an accent `Check` with "Added" / "Default".

  Keep every existing action: add, remove, rename, set default and expanded tiles.
- [ ] **Step 2: Filters become chips.**
  - "My models" / "Browse all" become a `.seg` with a sliding pill.
  - The other filters become toggle chips, `.fill` when on.
  - Keep the sort control, as a chip-styled select.
- [ ] **Step 3: Apply the same card to the image and video model libraries.**
- [ ] **Step 4: Run `npx tsc --noEmit`, then check in the browser** across all three libraries: add, remove and set
  default still work, and the cards tilt.
- [ ] **Step 5: Commit** with `feat(web): tilt cards in the model libraries`.

### Task 11: Images, Video and Discussions

**Files:**
- Modify: `web/src/pages/ImageThread.tsx`, `VideoThread.tsx`, `DiscussionPage.tsx`
- Modify: `web/src/components/ImageComposer.tsx`, `VideoComposer.tsx`, `FrameSlot.tsx`, `GeneratedPicker.tsx`,
  `Lightbox.tsx`, `MediaStatsPopover.tsx`
- Modify: `web/src/components/discussion/*`, `web/src/styles/pages.css`

**Interfaces:**
- Consumes: `ChipPopover` (Task 8), `TiltCard` (Task 4).

- [ ] **Step 1: Headers** follow the chat pattern: the title, then chips opening the existing popovers (media stats,
  participants, summary).
- [ ] **Step 2: Image and video composers** follow the chat composer's box and row styling. Model choice is a chip
  plus popover where it's a `<select>` today. Keep all frame, size and option controls.
- [ ] **Step 3: Results.**
  - Generated images and videos sit in a grid of rounded tiles, each wrapped in `TiltCard` with `max={8}`.
  - The `Lightbox` fades in and scales from 0.96.
  - Busy states keep their spinners.
- [ ] **Step 4: Discussions.**
  - The transcript reads like the chat conversation: each participant gets a 26 px mark in their existing participant
    color (not the accent).
  - The host's lines are styled like user bubbles.
  - Setup uses the new inputs and cards, but no tilt on forms.
- [ ] **Step 5: Run `npx tsc --noEmit` and `npx vitest run`, then check in the browser.**
  - Open an existing image thread, a video thread and a discussion.
  - The lightbox opens.
  - The video "finished" toast still links (Task 6 styling).
  - Nothing is paid for.
- [ ] **Step 6: Commit** with `feat(web): restyled images, video and discussions`.

### Task 12: Stats

**Files:**
- Modify: `web/src/pages/Stats.tsx`, `web/src/components/stats/*`, `web/src/styles/pages.css`

- [ ] **Step 1: `StatTiles` become `TiltCard`s.** The number is in mono at about 26 px, with a muted label.
- [ ] **Step 2: Restyle the charts' chrome.** Axes, gridlines, tooltips, the heatmap's empty cells and the
  `Segmented` range picker (now `.seg` + `.pill`) move to the neutral tokens. **Series colors stay exactly as they
  are.**
- [ ] **Step 3: Run `npx tsc --noEmit`, then check Stats in the browser** in dark and light mode, with every range.
- [ ] **Step 4: Commit** with `feat(web): restyled stats`.

### Task 13: Command palette

**Files:**
- Create: `web/src/lib/palette.ts`, `web/src/lib/palette.test.ts`, `web/src/components/shell/CommandPalette.tsx`
- Modify: `web/src/App.tsx`, `web/src/components/shell/ThreadPanel.tsx` (remove the interim inline search)

**Interfaces:**
- Consumes: `api.search`, `api.selectMessage`, `threadHref`, `setAppearance` and `nextTheme`.
- Produces:
  - `type PaletteGroup = 'Create' | 'Go to' | 'Appearance'`
  - `interface PaletteCommand { id: string; group: PaletteGroup; label: string; keywords?: string }`
  - `PALETTE_COMMANDS: PaletteCommand[]`, which contains:
    - New chat, New image, New video, New discussion
    - Model Library, Stats, and Settings: General, Appearance, Memory, Data, Spending limits
    - Toggle light/dark; Accent: Blue, Orange, Green, Rainbow; Color style: Flat, Vivid
  - `filterCommands(query: string, commands = PALETTE_COMMANDS): PaletteCommand[]`
    - case-insensitive
    - every whitespace-separated term must appear in `label + ' ' + (keywords ?? '')`
    - an empty query returns all commands
    - keeps the original order
  - `moveSelection(index: number, delta: number, count: number): number`. Clamps to `[0, count - 1]`, and returns 0
    when `count === 0`.

- [ ] **Step 1: Write a failing `palette.test.ts`.**
  - `filterCommands('')` has the full length.
  - `filterCommands('new vid')` returns `['New video']`.
  - `filterCommands('ACCENT green')` returns `['Accent: Green']`.
  - `filterCommands('zzz')` returns `[]`.
  - `moveSelection(0, -1, 5)` is 0, `(4, 1, 5)` is 4, `(2, 1, 0)` is 0.
- [ ] **Step 2: Run it.** Expected: FAIL. Implement, then run again. Expected: PASS.
- [ ] **Step 3: Build `CommandPalette`.**
  - Ctrl/Cmd+K anywhere opens it, and so does the panel's search button.
  - A centered sheet with a scale-and-fade pop.
  - The input is on top. Results are grouped:
    - **Chats:** the existing search API, debounced 250 ms, with `splitSnippet` highlighting. Opening a result calls
      `api.selectMessage` and then opens the thread, as Sidebar did.
    - **Create / Go to / Appearance:** from `filterCommands`.
  - One flat selection index across all visible rows. Arrows use `moveSelection`, Enter runs the row, Escape closes.
  - When nothing matches, show "No results".
  - If search fails, show "Search failed" muted in the Chats group, and keep the commands working.
- [ ] **Step 4: Run `npx tsc --noEmit` and `npx vitest run`.** Expected: PASS.
- [ ] **Step 5: Check in the browser.**
  - Ctrl+K opens it.
  - Typing filters the results.
  - Arrows and Enter work.
  - A chat search jumps to its message.
  - "Accent: Green" applies live and survives a reload.
  - Escape closes it.
- [ ] **Step 6: Commit** with `feat(web): command palette`.

### Task 14: Motion polish and the full sweep

**Files:**
- Modify: whichever `web/src/styles/*.css` and components need fixes

- [ ] **Step 1: Check motion against the spec.**
  - Press scale is about 0.96 on all buttons and chips.
  - Popovers scale from their anchor.
  - The theme and accent change crossfades colors over about 0.4 s: a `transition` on `background-color, color,
    border-color` for `body` and the main surfaces, disabled under `[data-motion='off']`.
  - Screen changes rise slightly.
  - The aurora layer sits behind the main content on every main page in Vivid and Rainbow.
- [ ] **Step 2: Check the switches.**
  - **Animations off:** no transitions or animations except spinners.
  - **Tilt off:** cards stay flat.
  - **OS reduced motion** (emulate it in the browser): the same as both off.
- [ ] **Step 3: Sweep the matrix.** Light and dark × Blue, Orange, Green and Rainbow × Flat and Vivid, on Chat home,
  a conversation, Images, Video, Discussions, Model Library, Stats and every Settings tab. Fix any:
  - contrast problems (text on `.fill` must stay readable; Green uses `--on-accent: #04130a` in dark mode)
  - accent leaking onto large surfaces
  - unstyled leftovers
- [ ] **Step 4: Check a narrow window.** At 800 px wide: no horizontal scroll, the panel opens as an overlay, and the
  Settings sheet fits.
- [ ] **Step 5: Run `npx vitest run` and `npx tsc --noEmit`.** Expected: PASS.
- [ ] **Step 6: Commit** with `feat(web): motion polish`.
