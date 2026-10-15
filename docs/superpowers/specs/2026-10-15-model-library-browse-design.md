# Model Library Browsing — Design

Date: 2026-10-15

## Goal

Make the Model Library's "Browse OpenRouter" section good at its main job: **finding capable, cheap models**. Add capability and provider facet chips, richer model cards with sorting, and a "Popular for <category>" shelf sourced from OpenRouter.

### Decisions made during brainstorming

- Primary use: find capable + cheap models. Facets and sorting come first; the popular shelf is secondary.
- Capability chips: full set, but Vision / Tools / File input are flagged "not used by OpenChat yet" (OpenChat only sends text today).
- Rankings source: bundle category lists into the existing daily catalog refresh (approach A), rather than a lazy per-category endpoint.

### Out of scope

Price sliders, persisting filter state across visits, per-provider endpoint details, changes to the "My models" section.

## Data source

`GET https://openrouter.ai/api/v1/models` already returns, per model: `description`, `created`, `architecture.input_modalities`, `supported_parameters`, `top_provider.max_completion_tokens`, which OpenChat currently discards.

`GET /models?category=<c>` returns ~13–20 models per category. Accepted values: `programming`, `roleplay`, `marketing`, `marketing/seo`, `technology`, `science`, `translation`, `legal`, `finance`, `health`, `trivia`, `academia`. Any other value is a 400. The order appears to be by usage but is not documented as a ranking, so the UI says "Popular for", never "#1".

## Section 1 — Data and server

### Types (`shared/types.ts`)

`CatalogModel` gains:

| field | type | source |
|---|---|---|
| `description` | `string` | `description` (empty string if missing) |
| `created` | `number \| null` | `created` (unix seconds) |
| `inputModalities` | `string[]` | `architecture.input_modalities` (default `['text']`) |
| `supportsTools` | `boolean` | `supported_parameters` includes `"tools"` |
| `supportsReasoning` | `boolean` | `supported_parameters` includes `"reasoning"` |
| `maxOutput` | `number \| null` | `top_provider.max_completion_tokens` |

New exports:

```ts
export type Category = 'programming' | 'roleplay' | 'marketing' | 'marketing/seo' | 'technology'
  | 'science' | 'translation' | 'legal' | 'finance' | 'health' | 'trivia' | 'academia';
export const CATEGORIES: { id: Category; label: string }[]; // display order, Programming first
```

`CatalogResponse` gains `rankings: Partial<Record<Category, string[]>>` (model ids, in API order).

`LibraryModel` is unchanged.

### OpenRouter client (`server/src/openrouter.ts`)

- `listModels()` maps the new fields with safe defaults for anything missing or malformed.
- New `listCategory(category: Category): Promise<string[]>` calls `/models?category=<category>` (URL-encoded) and returns ids in response order.

### Catalog cache (`server/src/catalog.ts`)

- On refresh, fetch `listModels()` and every `listCategory(c)` in parallel. `listModels()` failure behaves exactly as today (stale fallback or 502). Categories use `Promise.allSettled`; a rejected category is simply omitted from `rankings`.
- The `model_catalog_cache.json` column now stores `{ models, rankings }`. No schema migration.
- **Legacy cache:** if the stored JSON is an array (old format), treat it as expired and refetch. If that refetch fails, serve the legacy models as `stale: true`, normalized with defaults for the new fields (`description: ''`, `created: null`, `inputModalities: ['text']`, `supportsTools: false`, `supportsReasoning: false`, `maxOutput: null`) and `rankings: {}`.
- Adding a model to the library (`POST /api/models`) is unchanged.

## Section 2 — Page layout and behavior

"My models" is unchanged. "Browse OpenRouter" becomes, top to bottom:

1. **Toolbar:** search box, Sort select, Refresh button.
2. **Capability chips** ("Can do"): Reasoning, Free, Long context, Vision, Tools, File input.
   - Multi-select, **AND** semantics.
   - Reasoning = `supportsReasoning`; Free = prompt and completion price both exactly `0`; Long context = `contextLength >= 200_000`; Vision = `inputModalities` includes `image`; Tools = `supportsTools`; File input = `inputModalities` includes `file`.
   - Vision, Tools, File input are visually dimmed with a marker and tooltip: "Not used by OpenChat yet".
3. **Provider chips:** multi-select, **OR** semantics. The 8 providers with the most catalog models show first (ties broken alphabetically); a `+N` chip expands the remainder (alphabetical). Selected providers always stay visible. Replaces the current provider dropdown.
4. **Popular shelf:** "Popular for [category ▾]" with a category select (default Programming). Shows up to 10 compact cards from `rankings[category]`, in API order, after applying the active capability and provider chips. Horizontally scrollable. Hidden while the search box is non-empty, and hidden entirely when `rankings` is empty.
5. **Result count** ("142 models").
6. **Card grid:** 60 cards initially; "Show more" adds 60 more. Resets to 60 whenever filters, search or sort change.

### Sort options

- **Cheapest** (default): by `promptPrice + completionPrice` ascending. Free models first. Null or negative ("varies", e.g. `openrouter/auto`) prices last. Ties by name.
- **Newest:** `created` descending; null last.
- **Largest context:** `contextLength` descending; null last.
- **Name:** alphabetical by name.

Search keeps the current behavior (all whitespace-separated terms must appear in id or name).

### Cards (`ModelCard`)

Name; id in `<code>`; "New" badge when `created` is within 30 days; price as "Free" or "$in / $out per M"; context length; capability pills (Reasoning, Vision, Tools, File — the last three in the dimmed style); description clamped to 2 lines with the full text in a `title` tooltip; Add / Added button (same behavior as today). The shelf uses a `compact` variant (no description).

## Section 3 — Code structure, errors, testing

### Units

| file | responsibility |
|---|---|
| `server/src/openrouter.ts` | new field mapping; `listCategory` |
| `server/src/catalog.ts` | parallel fetch, `allSettled` rankings, legacy-cache upgrade |
| `shared/types.ts` | `Category`, `CATEGORIES`, extended `CatalogModel` / `CatalogResponse` |
| `web/src/lib/catalog.ts` | pure browsing engine: `capabilitiesOf`, `filterCatalog(models, { query, capabilities, providers })`, `sortCatalog(models, sort)`, `topProviders(models, n)`, `popularFor(models, rankings, category, filters)`, `isNew(model, now)`; keeps `providerOf` |
| `web/src/components/ModelCard.tsx` | one card; `compact` variant |
| `web/src/components/CatalogFilters.tsx` | search, sort, capability and provider chip rows |
| `web/src/components/PopularShelf.tsx` | category select + horizontal strip |
| `web/src/pages/ModelLibrary.tsx` | owns state, "My models", composes the above |
| `web/src/styles.css` | card grid, chips, shelf; existing CSS variables; responsive (grid collapses to one column on narrow widths) |

### Errors and edge cases

- Catalog load failure: unchanged (error with Retry; stale-cache banner).
- No rankings: shelf hidden.
- Shelf category with no matches under active filters: "No popular <Category> models match these filters."
- Grid with no matches: "No models match" with a "Clear filters" button that resets search, capability and provider chips.
- Legacy cache entries: normalized defaults (see Section 1).

### Testing

Server (vitest, existing patterns in `server/test/`):
- `listModels` maps every new field, including defaults for missing data.
- `listCategory` returns ids in order and URL-encodes `marketing/seo`.
- `getCatalog`: one category failing still returns the catalog with remaining rankings; a legacy array cache triggers a refetch; legacy cache plus a failed refetch returns normalized stale models with `rankings: {}`.

Web lib (`web/src/lib/catalog.test.ts`):
- Each capability predicate; AND across capabilities; OR across providers; combined with search.
- Each sort, including free-first and null/negative-price-last for Cheapest.
- `topProviders` ordering and tie-break.
- `popularFor` preserves API order, respects filters, skips ids missing from the catalog, caps at 10.
- `isNew` at the 30-day boundary.

Manual verification in the browser preview: chips, sort, shelf category switch, Show more, empty states, narrow width.
