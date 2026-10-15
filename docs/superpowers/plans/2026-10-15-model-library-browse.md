# Model Library Browsing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn "Browse OpenRouter" into a faceted model browser — capability and provider chips, sortable model cards, and a "Popular for <category>" shelf — optimized for finding capable, cheap models.

**Architecture:** The server keeps its single 24h catalog cache but now stores richer per-model fields plus per-category ranked id lists fetched in parallel with `/models`. The web page receives one `CatalogResponse` and does all filtering, sorting and shelf selection client-side through pure functions in `web/src/lib/catalog.ts`; thin React components render cards, chips and the shelf.

**Tech Stack:** TypeScript, Hono (server), better-sqlite3 cache table, React 18 + Vite (web), Vitest (`*.test.ts`, logic only — no component tests).

**Spec:** `docs/superpowers/specs/2026-10-15-model-library-browse-design.md`

## Global Constraints

- Category values accepted by OpenRouter (anything else is a 400): `programming`, `roleplay`, `marketing`, `marketing/seo`, `technology`, `science`, `translation`, `legal`, `finance`, `health`, `trivia`, `academia`. Encode with `encodeURIComponent` (`marketing%2Fseo` is verified to work).
- UI copy says "Popular for", never "#1" or "Top".
- Long context = `contextLength >= 200_000`. Free = prompt **and** completion price exactly `0`. New = `created` within 30 days.
- Vision, Tools, File input are flagged "Not used by OpenChat yet".
- Shelf: up to 10 cards, default category Programming, hidden while the search box is non-empty, hidden entirely when there are no rankings.
- Grid: 60 cards, "Show more" adds 60; resets to 60 when filters or sort change.
- Default sort: Cheapest. Null or negative prices sort last.
- No schema migration: `model_catalog_cache.json` stores `{ models, rankings }`; legacy array rows are refetched.
- Use existing CSS variables only (`--surface`, `--border`, `--accent`, `--muted`, …) so light and dark themes both work.
- Verify every task with `npm test` and `npm run typecheck` (both from the repo root).

## Review Focus

- A `CatalogResponse` without `rankings` (older cached tab, partial cache row) must not crash the page — the shelf just hides. Pinned in Task 2 (cache row missing `rankings`) and Task 3 (`popularFor` with `{}`).
- A model with one free side and one paid side (prompt `0`, completion `> 0`) must not be labeled or filtered as Free. Pinned in Task 3.
- Ranked ids that aren't in the catalog (cache skew, brand-new model) must be skipped, not rendered as broken cards. Pinned in Task 3.
- A whitespace-only search must behave like an empty search (all models, shelf visible). Pinned in Task 3.
- `openrouter/auto`-style "varies" prices (negative) must sort after every real price, including unknown ones' tie-break by name. Pinned in Task 3.

---

## File Structure

| file | change | responsibility |
|---|---|---|
| `shared/types.ts` | modify | extended `CatalogModel`, `Category`, `CATEGORIES`, `withCatalogDefaults`, `CatalogResponse.rankings` |
| `server/src/openrouter.ts` | modify | map new fields; `listCategory` |
| `server/src/catalog.ts` | modify | parallel rankings fetch, new cache format, legacy upgrade |
| `server/src/routes/models.ts` | modify | fallback meta via `withCatalogDefaults` |
| `server/test/appHelpers.ts` | modify | default `listCategory` stub |
| `server/test/openrouter.test.ts` | modify | new mapping + `listCategory` tests |
| `server/test/models.test.ts` | modify | rankings + legacy cache tests |
| `web/src/lib/catalog.ts` | modify | pure browsing engine |
| `web/src/lib/catalog.test.ts` | modify | engine tests |
| `web/src/components/ModelCard.tsx` | create | one card (+ `compact`) |
| `web/src/components/CatalogFilters.tsx` | create | search, sort, chip rows |
| `web/src/components/PopularShelf.tsx` | create | category select + strip |
| `web/src/pages/ModelLibrary.tsx` | modify | state + composition |
| `web/src/styles.css` | modify | grid, cards, chips, shelf |

---

### Task 1: Richer catalog fields and category listing from OpenRouter

**Files:**
- Modify: `shared/types.ts:39-52`
- Modify: `server/src/openrouter.ts:38-44` (helpers), `:55-60` (interface), `:86-96` (`listModels`)
- Modify: `server/src/routes/models.ts:23`
- Modify: `server/test/appHelpers.ts:9-15`
- Test: `server/test/openrouter.test.ts`, fixtures in `server/test/models.test.ts:6-10`, `web/src/lib/catalog.test.ts:5`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `CatalogModel` with `description: string`, `created: number | null` (unix **seconds**), `inputModalities: string[]`, `supportsTools: boolean`, `supportsReasoning: boolean`, `maxOutput: number | null` in addition to the existing fields.
  - `type Category` (12-value union) and `const CATEGORIES: { id: Category; label: string }[]` (Programming first).
  - `withCatalogDefaults(m: Partial<CatalogModel> & { id: string }): CatalogModel`.
  - `CatalogResponse.rankings: Partial<Record<Category, string[]>>`.
  - `OpenRouterClient.listCategory(category: Category): Promise<string[]>`.

- [ ] **Step 1: Write the failing tests**

In `server/test/openrouter.test.ts`, change the existing `'lists models with numeric prices'` assertion from `toEqual` to `toMatchObject` (the old fields stay checked; new fields are covered below), then add these two tests inside the same `describe`:

```ts
  it('maps capability, description and date fields, with defaults when missing', async () => {
    const { fn } = fakeFetch(() => Response.json({
      data: [
        {
          id: 'a/full', name: 'Full', description: 'Does it all', created: 1792102385, context_length: 200000,
          pricing: { prompt: '0', completion: '0' },
          architecture: { input_modalities: ['text', 'image', 'file'] },
          supported_parameters: ['tools', 'reasoning', 'temperature'],
          top_provider: { max_completion_tokens: 8192 },
        },
        { id: 'a/bare', architecture: { input_modalities: 'nonsense' }, supported_parameters: null, top_provider: { max_completion_tokens: 0 } },
      ],
    }));
    const models = await createOpenRouterClient(fn).listModels();
    expect(models[0]).toEqual({
      id: 'a/full', name: 'Full', contextLength: 200000, promptPrice: 0, completionPrice: 0,
      description: 'Does it all', created: 1792102385, inputModalities: ['text', 'image', 'file'],
      supportsTools: true, supportsReasoning: true, maxOutput: 8192,
    });
    expect(models[1]).toEqual({
      id: 'a/bare', name: 'a/bare', contextLength: null, promptPrice: null, completionPrice: null,
      description: '', created: null, inputModalities: ['text'],
      supportsTools: false, supportsReasoning: false, maxOutput: null,
    });
  });

  it('lists a category as ordered ids and encodes marketing/seo', async () => {
    const { fn, calls } = fakeFetch(() => Response.json({ data: [{ id: 'b/two' }, { id: 'a/one' }] }));
    expect(await createOpenRouterClient(fn).listCategory('marketing/seo')).toEqual(['b/two', 'a/one']);
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/models?category=marketing%2Fseo');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/test/openrouter.test.ts`
Expected: FAIL — the mapping test reports missing fields (`description`, …) and the category test fails with `listCategory is not a function`.

- [ ] **Step 3: Extend the shared types**

In `shared/types.ts`, replace the `CatalogModel` and `CatalogResponse` interfaces (lines 39-52) with:

```ts
export interface CatalogModel {
  id: string;
  name: string;
  contextLength: number | null;
  /** USD per token; null if unknown, negative means "varies" (e.g. openrouter/auto). */
  promptPrice: number | null;
  completionPrice: number | null;
  description: string;
  /** Unix seconds when OpenRouter listed the model; null if unknown. */
  created: number | null;
  /** e.g. ['text', 'image', 'file']. */
  inputModalities: string[];
  supportsTools: boolean;
  supportsReasoning: boolean;
  maxOutput: number | null;
}

/** Fills the fields older cache rows and fallback lookups don't carry. */
export function withCatalogDefaults(m: Partial<CatalogModel> & { id: string }): CatalogModel {
  return {
    name: m.id,
    contextLength: null,
    promptPrice: null,
    completionPrice: null,
    description: '',
    created: null,
    inputModalities: ['text'],
    supportsTools: false,
    supportsReasoning: false,
    maxOutput: null,
    ...m,
  };
}

/** OpenRouter's `/models?category=` values. */
export type Category =
  | 'programming' | 'roleplay' | 'marketing' | 'marketing/seo' | 'technology' | 'science'
  | 'translation' | 'legal' | 'finance' | 'health' | 'trivia' | 'academia';

export const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'programming', label: 'Programming' },
  { id: 'roleplay', label: 'Roleplay' },
  { id: 'marketing', label: 'Marketing' },
  { id: 'marketing/seo', label: 'SEO' },
  { id: 'technology', label: 'Technology' },
  { id: 'science', label: 'Science' },
  { id: 'translation', label: 'Translation' },
  { id: 'legal', label: 'Legal' },
  { id: 'finance', label: 'Finance' },
  { id: 'health', label: 'Health' },
  { id: 'trivia', label: 'Trivia' },
  { id: 'academia', label: 'Academia' },
];

export interface CatalogResponse {
  models: CatalogModel[];
  /** Model ids per category, in OpenRouter's order; categories that failed to load are absent. */
  rankings: Partial<Record<Category, string[]>>;
  fetchedAt: number;
  stale: boolean;
}
```

- [ ] **Step 4: Map the new fields and add `listCategory`**

In `server/src/openrouter.ts`:

Change the type import on line 2 to:

```ts
import type { CatalogModel, Category } from '../../shared/types';
```

After the `toPrice` helper (line 44), add:

```ts
const toCount = (value: unknown): number | null => (typeof value === 'number' && value > 0 ? value : null);

const toStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
```

In the `OpenRouterClient` interface, add after `listModels(): Promise<CatalogModel[]>;`:

```ts
  listCategory(category: Category): Promise<string[]>;
```

Replace the body of `listModels` and add `listCategory` right after it:

```ts
    async listModels() {
      const res = await request('/models');
      const json = (await res.json()) as { data?: any[] };
      return (json.data ?? []).map((m) => {
        const params = toStrings(m.supported_parameters);
        const inputs = toStrings(m.architecture?.input_modalities);
        return {
          id: String(m.id),
          name: String(m.name ?? m.id),
          contextLength: typeof m.context_length === 'number' ? m.context_length : null,
          promptPrice: toPrice(m.pricing?.prompt),
          completionPrice: toPrice(m.pricing?.completion),
          description: typeof m.description === 'string' ? m.description : '',
          created: typeof m.created === 'number' ? m.created : null,
          inputModalities: inputs.length ? inputs : ['text'],
          supportsTools: params.includes('tools'),
          supportsReasoning: params.includes('reasoning'),
          maxOutput: toCount(m.top_provider?.max_completion_tokens),
        };
      });
    },

    async listCategory(category) {
      const res = await request(`/models?category=${encodeURIComponent(category)}`);
      const json = (await res.json()) as { data?: any[] };
      return (json.data ?? []).map((m) => String(m.id));
    },
```

- [ ] **Step 5: Update callers and fixtures so everything type-checks**

`server/src/routes/models.ts` line 23 — replace the inline fallback object:

```ts
    const meta = catalog?.models.find((m) => m.id === id) ?? withCatalogDefaults({ id });
```

and add the import at the top:

```ts
import { withCatalogDefaults } from '../../../shared/types';
```

`server/test/appHelpers.ts` — add a default stub to the `client` object, after `listModels`:

```ts
    listCategory: async () => [],
```

`server/test/models.test.ts` — wrap the `CATALOG` fixture entries (lines 6-10) so they carry the new fields:

```ts
const CATALOG: CatalogModel[] = [
  { id: 'openai/gpt-4o:free', name: 'GPT-4o (free)', contextLength: 128000, promptPrice: 0, completionPrice: 0 },
  { id: '~anthropic/claude', name: 'Claude', contextLength: 200000, promptPrice: 0.000003, completionPrice: 0.000015 },
  { id: 'google/gemini', name: 'Gemini', contextLength: 1000000, promptPrice: 0.000001, completionPrice: 0.000004 },
].map(withCatalogDefaults);
```

and add `withCatalogDefaults` as a value import:

```ts
import { withCatalogDefaults } from '../../shared/types';
```

`web/src/lib/catalog.test.ts` line 5 — replace the `m` helper:

```ts
const m = (id: string, name: string): CatalogModel => withCatalogDefaults({ id, name });
```

and add `import { withCatalogDefaults } from '../../../shared/types';`.

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test` then `npm run typecheck`
Expected: all tests PASS; typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add shared/types.ts server/src/openrouter.ts server/src/routes/models.ts server/test/appHelpers.ts server/test/openrouter.test.ts server/test/models.test.ts web/src/lib/catalog.test.ts
git commit -m "feat(server): map model capabilities from OpenRouter and list category rankings"
```

---

### Task 2: Bundle category rankings into the catalog cache

**Files:**
- Modify: `server/src/catalog.ts` (whole file)
- Test: `server/test/models.test.ts` (inside `describe('catalog', …)`)

**Interfaces:**
- Consumes: `OpenRouterClient.listCategory`, `CATEGORIES`, `withCatalogDefaults`, `CatalogResponse.rankings` (Task 1).
- Produces: `GET /api/models/catalog` → `CatalogResponse` with `rankings` always present (possibly `{}`).

- [ ] **Step 1: Write the failing tests**

Add to `server/test/models.test.ts` inside `describe('catalog', …)`:

```ts
  it('bundles category rankings and leaves out categories that fail', async () => {
    const { call } = makeApp({
      listModels: async () => CATALOG,
      listCategory: async (category) => {
        if (category === 'roleplay') throw new OpenRouterError('boom', 502);
        return category === 'programming' ? ['google/gemini', '~anthropic/claude'] : [];
      },
    });
    const res = (await (await call('GET', '/api/models/catalog')).json()) as CatalogResponse;
    expect(res.models).toHaveLength(3);
    expect(res.rankings.programming).toEqual(['google/gemini', '~anthropic/claude']);
    expect(res.rankings.legal).toEqual([]);
    expect(res.rankings).not.toHaveProperty('roleplay');
  });

  it('caches rankings with the models', async () => {
    let rankingCalls = 0;
    const { call } = makeApp({ listModels: async () => CATALOG, listCategory: async () => { rankingCalls++; return ['google/gemini']; } });
    await call('GET', '/api/models/catalog');
    const second = (await (await call('GET', '/api/models/catalog')).json()) as CatalogResponse;
    expect(rankingCalls).toBe(12);
    expect(second.rankings.programming).toEqual(['google/gemini']);
  });

  it('refetches a legacy array cache even when it is fresh', async () => {
    const { db, call, calls } = setup();
    db.prepare('INSERT INTO model_catalog_cache (id, fetched_at, json) VALUES (1, ?, ?)')
      .run(Date.now(), JSON.stringify([{ id: 'old/model', name: 'Old', contextLength: null, promptPrice: null, completionPrice: null }]));
    const res = (await (await call('GET', '/api/models/catalog')).json()) as CatalogResponse;
    expect(calls()).toBe(1);
    expect(res.models).toHaveLength(3);
  });

  it('serves a legacy cache as stale with defaults when the refetch fails', async () => {
    const { db, call } = makeApp({ listModels: async () => { throw new OpenRouterError('Could not reach OpenRouter.', 0); } });
    const legacy = { id: 'old/model', name: 'Old', contextLength: 8000, promptPrice: 0, completionPrice: 0 };
    db.prepare('INSERT INTO model_catalog_cache (id, fetched_at, json) VALUES (1, ?, ?)').run(Date.now(), JSON.stringify([legacy]));
    const res = (await (await call('GET', '/api/models/catalog')).json()) as CatalogResponse;
    expect(res.stale).toBe(true);
    expect(res.rankings).toEqual({});
    expect(res.models).toEqual([withCatalogDefaults(legacy)]);
  });

  it('treats a cache row without rankings as having none', async () => {
    const { db, call } = makeApp({ listModels: async () => CATALOG });
    db.prepare('INSERT INTO model_catalog_cache (id, fetched_at, json) VALUES (1, ?, ?)').run(Date.now(), JSON.stringify({ models: CATALOG }));
    const res = (await (await call('GET', '/api/models/catalog')).json()) as CatalogResponse;
    expect(res.rankings).toEqual({});
    expect(res.models).toHaveLength(3);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/test/models.test.ts`
Expected: FAIL — `rankings` is undefined; the legacy refetch test sees `calls()` of 0.

- [ ] **Step 3: Implement the new cache**

Replace `server/src/catalog.ts` with:

```ts
import type { DB } from './db';
import { HttpError } from './http';
import type { OpenRouterClient } from './openrouter';
import { CATEGORIES, withCatalogDefaults } from '../../shared/types';
import type { CatalogModel, CatalogResponse } from '../../shared/types';

export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

type Rankings = CatalogResponse['rankings'];
interface Cached { models: CatalogModel[]; rankings: Rankings; fetchedAt: number; legacy: boolean }

/** Rows written before rankings existed hold a bare model array; they're flagged legacy so they get refetched. */
function readCache(db: DB): Cached | undefined {
  const row = db.prepare('SELECT fetched_at, json FROM model_catalog_cache WHERE id = 1').get() as
    | { fetched_at: number; json: string }
    | undefined;
  if (!row) return undefined;
  const parsed = JSON.parse(row.json);
  if (Array.isArray(parsed)) return { models: parsed.map(withCatalogDefaults), rankings: {}, fetchedAt: row.fetched_at, legacy: true };
  return { models: parsed.models, rankings: parsed.rankings ?? {}, fetchedAt: row.fetched_at, legacy: false };
}

async function fetchRankings(openrouter: OpenRouterClient): Promise<Rankings> {
  const results = await Promise.allSettled(CATEGORIES.map((c) => openrouter.listCategory(c.id)));
  const rankings: Rankings = {};
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') rankings[CATEGORIES[i].id] = r.value;
  });
  return rankings;
}

export async function getCatalog(db: DB, openrouter: OpenRouterClient, refresh: boolean): Promise<CatalogResponse> {
  const cached = readCache(db);
  if (cached && !cached.legacy && !refresh && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) {
    return { models: cached.models, rankings: cached.rankings, fetchedAt: cached.fetchedAt, stale: false };
  }
  try {
    const [list, rankings] = await Promise.all([openrouter.listModels(), fetchRankings(openrouter)]);
    const models = list.sort((a, b) => a.name.localeCompare(b.name));
    const fetchedAt = Date.now();
    db.prepare(
      'INSERT INTO model_catalog_cache (id, fetched_at, json) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET fetched_at = excluded.fetched_at, json = excluded.json',
    ).run(fetchedAt, JSON.stringify({ models, rankings }));
    return { models, rankings, fetchedAt, stale: false };
  } catch (err) {
    if (cached) return { models: cached.models, rankings: cached.rankings, fetchedAt: cached.fetchedAt, stale: true };
    throw new HttpError(502, (err as Error).message);
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test` then `npm run typecheck`
Expected: all PASS (including the pre-existing cache/stale tests); typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add server/src/catalog.ts server/test/models.test.ts
git commit -m "feat(server): cache category rankings alongside the model catalog"
```

---

### Task 3: Browsing engine — filter, sort, providers, popular, new

**Files:**
- Modify: `web/src/lib/catalog.ts` (whole file)
- Modify: `web/src/pages/ModelLibrary.tsx:35` (keep compiling against the new `filterCatalog` signature)
- Test: `web/src/lib/catalog.test.ts` (whole file)

**Interfaces:**
- Consumes: `CatalogModel`, `CatalogResponse`, `Category`, `withCatalogDefaults` (Task 1).
- Produces (all exported from `web/src/lib/catalog.ts`):
  - `providerOf(id: string): string` (unchanged)
  - `type Capability = 'reasoning' | 'free' | 'longContext' | 'vision' | 'tools' | 'file'`
  - `CAPABILITIES: { id: Capability; label: string; usedByOpenChat: boolean }[]`
  - `UNUSED_HINT = 'Not used by OpenChat yet'`
  - `capabilitiesOf(m: CatalogModel): Capability[]` (in `CAPABILITIES` order)
  - `interface CatalogFilter { query: string; capabilities: Capability[]; providers: string[] }`, `NO_FILTER: CatalogFilter`, `isFiltering(f: CatalogFilter): boolean`
  - `filterCatalog(models: CatalogModel[], filter: CatalogFilter): CatalogModel[]`
  - `type SortKey = 'cheapest' | 'newest' | 'context' | 'name'`, `SORTS: { id: SortKey; label: string }[]`
  - `sortCatalog(models: CatalogModel[], sort: SortKey): CatalogModel[]` (returns a new array)
  - `topProviders(models: CatalogModel[], n: number): { top: string[]; rest: string[] }`
  - `SHELF_SIZE = 10`, `popularFor(models: CatalogModel[], rankings: CatalogResponse['rankings'], category: Category, filter: Pick<CatalogFilter, 'capabilities' | 'providers'>): CatalogModel[]`
  - `isNew(m: CatalogModel, now?: number): boolean` (`now` in ms)

- [ ] **Step 1: Write the failing tests**

Replace `web/src/lib/catalog.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import {
  capabilitiesOf, filterCatalog, isFiltering, isNew, NO_FILTER, popularFor, providerOf, sortCatalog, topProviders,
  type Capability,
} from './catalog';
import { withCatalogDefaults, type CatalogModel } from '../../../shared/types';

const m = (id: string, o: Partial<CatalogModel> = {}): CatalogModel => withCatalogDefaults({ id, name: id, ...o });
const ids = (list: CatalogModel[]) => list.map((x) => x.id);

describe('search and provider filtering', () => {
  const models = [
    m('openai/gpt-4o', { name: 'OpenAI: GPT-4o' }),
    m('anthropic/claude-sonnet', { name: 'Anthropic: Claude Sonnet' }),
    m('~anthropic/claude-latest', { name: 'Claude Latest' }),
    m('google/gemini', { name: 'Gemini' }),
  ];

  it('extracts the provider', () => {
    expect(providerOf('openai/gpt-4o')).toBe('openai');
    expect(providerOf('~anthropic/claude-latest')).toBe('anthropic');
  });

  it('matches every query term against id and name', () => {
    expect(ids(filterCatalog(models, { ...NO_FILTER, query: 'claude son' }))).toEqual(['anthropic/claude-sonnet']);
    expect(ids(filterCatalog(models, { ...NO_FILTER, query: 'GPT' }))).toEqual(['openai/gpt-4o']);
  });

  it('treats a whitespace-only query as no query', () => {
    expect(filterCatalog(models, { ...NO_FILTER, query: '   ' })).toHaveLength(4);
    expect(isFiltering({ ...NO_FILTER, query: '   ' })).toBe(false);
    expect(isFiltering({ ...NO_FILTER, providers: ['openai'] })).toBe(true);
  });

  it('ORs selected providers', () => {
    expect(ids(filterCatalog(models, { ...NO_FILTER, providers: ['openai', 'google'] }))).toEqual(['openai/gpt-4o', 'google/gemini']);
    expect(ids(filterCatalog(models, { ...NO_FILTER, providers: ['anthropic'] }))).toEqual(['anthropic/claude-sonnet', '~anthropic/claude-latest']);
  });
});

describe('capabilities', () => {
  const caps = [
    m('a/reason', { supportsReasoning: true }),
    m('a/free', { promptPrice: 0, completionPrice: 0 }),
    m('a/halffree', { promptPrice: 0, completionPrice: 0.000001 }),
    m('a/long', { contextLength: 200_000 }),
    m('a/short', { contextLength: 199_999 }),
    m('a/vision', { inputModalities: ['text', 'image'] }),
    m('a/tools', { supportsTools: true }),
    m('a/file', { inputModalities: ['text', 'file'] }),
    m('a/all', {
      supportsReasoning: true, supportsTools: true, inputModalities: ['text', 'image', 'file'],
      contextLength: 1_000_000, promptPrice: 0, completionPrice: 0,
    }),
  ];
  const only = (c: Capability) => ids(filterCatalog(caps, { ...NO_FILTER, capabilities: [c] }));

  it('filters on each capability', () => {
    expect(only('reasoning')).toEqual(['a/reason', 'a/all']);
    expect(only('free')).toEqual(['a/free', 'a/all']);
    expect(only('longContext')).toEqual(['a/long', 'a/all']);
    expect(only('vision')).toEqual(['a/vision', 'a/all']);
    expect(only('tools')).toEqual(['a/tools', 'a/all']);
    expect(only('file')).toEqual(['a/file', 'a/all']);
  });

  it('does not count a half-free model as free', () => {
    expect(capabilitiesOf(caps[2])).toEqual([]);
  });

  it('ANDs selected capabilities', () => {
    expect(ids(filterCatalog(caps, { ...NO_FILTER, capabilities: ['reasoning', 'tools'] }))).toEqual(['a/all']);
  });

  it('lists capabilities in display order', () => {
    expect(capabilitiesOf(caps[8])).toEqual(['reasoning', 'free', 'longContext', 'vision', 'tools', 'file']);
  });
});

describe('sorting', () => {
  const list = [
    m('p/varies', { name: 'Varies', promptPrice: -1, completionPrice: -1, created: 300, contextLength: 2_000_000 }),
    m('p/unknown', { name: 'Unknown', created: null, contextLength: null }),
    m('p/pricey', { name: 'Pricey', promptPrice: 0.00001, completionPrice: 0.00003, created: 100, contextLength: 128_000 }),
    m('p/free', { name: 'Free', promptPrice: 0, completionPrice: 0, created: 200, contextLength: 32_000 }),
    m('p/cheap', { name: 'Cheap', promptPrice: 0.0000001, completionPrice: 0.0000004, created: 200, contextLength: 128_000 }),
  ];

  it('cheapest puts free first and unknown or varying prices last, ties by name', () => {
    expect(ids(sortCatalog(list, 'cheapest'))).toEqual(['p/free', 'p/cheap', 'p/pricey', 'p/unknown', 'p/varies']);
  });

  it('newest puts unknown dates last, ties by name', () => {
    expect(ids(sortCatalog(list, 'newest'))).toEqual(['p/varies', 'p/cheap', 'p/free', 'p/pricey', 'p/unknown']);
  });

  it('largest context puts unknown last, ties by name', () => {
    expect(ids(sortCatalog(list, 'context'))).toEqual(['p/varies', 'p/cheap', 'p/pricey', 'p/free', 'p/unknown']);
  });

  it('name sorts alphabetically without mutating the input', () => {
    const before = ids(list);
    expect(ids(sortCatalog(list, 'name'))).toEqual(['p/cheap', 'p/free', 'p/pricey', 'p/unknown', 'p/varies']);
    expect(ids(list)).toEqual(before);
  });
});

describe('topProviders', () => {
  it('ranks by model count, ties alphabetical, rest alphabetical', () => {
    const list = ['openai/a', 'openai/b', 'openai/c', 'google/a', 'google/b', 'anthropic/a', 'anthropic/b', 'x/a', 'b/a'].map((id) => m(id));
    expect(topProviders(list, 3)).toEqual({ top: ['openai', 'anthropic', 'google'], rest: ['b', 'x'] });
  });
});

describe('popularFor', () => {
  const catalog = Array.from({ length: 14 }, (_, i) => m(`g/${i}`, { supportsTools: i % 2 === 0 }));

  it('keeps OpenRouter order, skips unknown ids and caps at 10', () => {
    const rest = catalog.map((x) => x.id).filter((id) => id !== 'g/3' && id !== 'g/1');
    const ranked = ['g/3', 'missing/x', 'g/1', ...rest];
    const result = ids(popularFor(catalog, { programming: ranked }, 'programming', NO_FILTER));
    expect(result.slice(0, 2)).toEqual(['g/3', 'g/1']);
    expect(result).not.toContain('missing/x');
    expect(result).toHaveLength(10);
  });

  it('applies capability and provider filters', () => {
    const result = popularFor(catalog, { programming: ['g/1', 'g/2', 'g/4'] }, 'programming', { capabilities: ['tools'], providers: [] });
    expect(ids(result)).toEqual(['g/2', 'g/4']);
    expect(popularFor(catalog, { programming: ['g/1'] }, 'programming', { capabilities: [], providers: ['other'] })).toEqual([]);
  });

  it('returns nothing for a category without rankings', () => {
    expect(popularFor(catalog, {}, 'legal', NO_FILTER)).toEqual([]);
  });
});

describe('isNew', () => {
  const now = Date.UTC(2026, 9, 15);
  const DAY_S = 86_400;
  it('is true up to 30 days old and false after or when unknown', () => {
    expect(isNew(m('a/x', { created: now / 1000 - 30 * DAY_S }), now)).toBe(true);
    expect(isNew(m('a/x', { created: now / 1000 - 30 * DAY_S - 1 }), now)).toBe(false);
    expect(isNew(m('a/x', { created: null }), now)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run web/src/lib/catalog.test.ts`
Expected: FAIL — `capabilitiesOf`, `sortCatalog`, etc. are not exported.

- [ ] **Step 3: Implement the engine**

Replace `web/src/lib/catalog.ts` with:

```ts
import type { CatalogModel, CatalogResponse, Category } from '../../../shared/types';

export const providerOf = (id: string): string => id.replace(/^~/, '').split('/')[0];

export type Capability = 'reasoning' | 'free' | 'longContext' | 'vision' | 'tools' | 'file';

export const CAPABILITIES: { id: Capability; label: string; usedByOpenChat: boolean }[] = [
  { id: 'reasoning', label: 'Reasoning', usedByOpenChat: true },
  { id: 'free', label: 'Free', usedByOpenChat: true },
  { id: 'longContext', label: 'Long context', usedByOpenChat: true },
  { id: 'vision', label: 'Vision', usedByOpenChat: false },
  { id: 'tools', label: 'Tools', usedByOpenChat: false },
  { id: 'file', label: 'File input', usedByOpenChat: false },
];

export const UNUSED_HINT = 'Not used by OpenChat yet';
export const LONG_CONTEXT = 200_000;

const HAS: Record<Capability, (m: CatalogModel) => boolean> = {
  reasoning: (m) => m.supportsReasoning,
  free: (m) => m.promptPrice === 0 && m.completionPrice === 0,
  longContext: (m) => (m.contextLength ?? 0) >= LONG_CONTEXT,
  vision: (m) => m.inputModalities.includes('image'),
  tools: (m) => m.supportsTools,
  file: (m) => m.inputModalities.includes('file'),
};

export const capabilitiesOf = (m: CatalogModel): Capability[] => CAPABILITIES.map((c) => c.id).filter((id) => HAS[id](m));

export interface CatalogFilter {
  query: string;
  /** All must match. */
  capabilities: Capability[];
  /** Any may match; empty means every provider. */
  providers: string[];
}

export const NO_FILTER: CatalogFilter = { query: '', capabilities: [], providers: [] };

export const isFiltering = (f: CatalogFilter): boolean => f.query.trim() !== '' || f.capabilities.length > 0 || f.providers.length > 0;

export function filterCatalog(models: CatalogModel[], { query, capabilities, providers }: CatalogFilter): CatalogModel[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return models.filter((m) => {
    if (providers.length && !providers.includes(providerOf(m.id))) return false;
    if (!capabilities.every((c) => HAS[c](m))) return false;
    const haystack = `${m.id} ${m.name}`.toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}

export type SortKey = 'cheapest' | 'newest' | 'context' | 'name';

export const SORTS: { id: SortKey; label: string }[] = [
  { id: 'cheapest', label: 'Cheapest' },
  { id: 'newest', label: 'Newest' },
  { id: 'context', label: 'Largest context' },
  { id: 'name', label: 'Name' },
];

/** Input + output price per token, or null when either is unknown or "varies". */
function totalPrice(m: CatalogModel): number | null {
  const { promptPrice: p, completionPrice: c } = m;
  return p === null || c === null || p < 0 || c < 0 ? null : p + c;
}

/** Compares with nulls last; `dir` 1 is ascending, -1 descending. */
const nullsLast = (a: number | null, b: number | null, dir: 1 | -1): number =>
  a === null ? (b === null ? 0 : 1) : b === null ? -1 : (a - b) * dir;

const byName = (a: CatalogModel, b: CatalogModel) => a.name.localeCompare(b.name);

const COMPARE: Record<SortKey, (a: CatalogModel, b: CatalogModel) => number> = {
  cheapest: (a, b) => nullsLast(totalPrice(a), totalPrice(b), 1) || byName(a, b),
  newest: (a, b) => nullsLast(a.created, b.created, -1) || byName(a, b),
  context: (a, b) => nullsLast(a.contextLength, b.contextLength, -1) || byName(a, b),
  name: byName,
};

export const sortCatalog = (models: CatalogModel[], sort: SortKey): CatalogModel[] => [...models].sort(COMPARE[sort]);

/** The `n` providers with the most models (ties alphabetical), and the rest alphabetically. */
export function topProviders(models: CatalogModel[], n: number): { top: string[]; rest: string[] } {
  const counts = new Map<string, number>();
  for (const m of models) counts.set(providerOf(m.id), (counts.get(providerOf(m.id)) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([p]) => p);
  return { top: ranked.slice(0, n), rest: ranked.slice(n).sort() };
}

export const SHELF_SIZE = 10;

/** A category's ranked models that are in the catalog and pass the chips, in OpenRouter's order. */
export function popularFor(
  models: CatalogModel[],
  rankings: CatalogResponse['rankings'],
  category: Category,
  filter: Pick<CatalogFilter, 'capabilities' | 'providers'>,
): CatalogModel[] {
  const byId = new Map(models.map((m) => [m.id, m]));
  const ranked = (rankings[category] ?? []).map((id) => byId.get(id)).filter((m): m is CatalogModel => m !== undefined);
  return filterCatalog(ranked, { ...filter, query: '' }).slice(0, SHELF_SIZE);
}

const NEW_MS = 30 * 86_400_000;

export const isNew = (m: CatalogModel, now = Date.now()): boolean => m.created !== null && now - m.created * 1000 <= NEW_MS;
```

- [ ] **Step 4: Keep the page compiling**

In `web/src/pages/ModelLibrary.tsx`, replace line 35 with the new call shape (the page is rewired properly in Task 5):

```ts
  const filtered = useMemo(
    () => filterCatalog(catalog?.models ?? [], { query, capabilities: [], providers: provider ? [provider] : [] }),
    [catalog, query, provider],
  );
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test` then `npm run typecheck`
Expected: all PASS; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/catalog.ts web/src/lib/catalog.test.ts web/src/pages/ModelLibrary.tsx
git commit -m "feat(web): catalog browsing engine with capability filters, sorting and popular picks"
```

---

### Task 4: Card, filter and shelf components with styles

**Files:**
- Create: `web/src/components/ModelCard.tsx`
- Create: `web/src/components/CatalogFilters.tsx`
- Create: `web/src/components/PopularShelf.tsx`
- Modify: `web/src/styles.css` (append a `/* Model browser */` block at the end)

**Interfaces:**
- Consumes: everything Task 3 exports; `CATEGORIES`, `Category`, `CatalogModel` (Task 1); `formatContext`, `formatPricePerM` from `web/src/lib/format.ts`.
- Produces:
  - `ModelCard(props: { model: CatalogModel; added: boolean; busy: boolean; onAdd(): void; compact?: boolean })` → renders an `<li className="model-card">`.
  - `CatalogFilters(props: { filter: CatalogFilter; onFilter(next: CatalogFilter): void; sort: SortKey; onSort(next: SortKey): void; providers: { top: string[]; rest: string[] }; loading: boolean; onRefresh(): void })`.
  - `PopularShelf(props: { category: Category; onCategory(next: Category): void; available: Category[]; models: CatalogModel[]; added: Set<string>; busy: string | null; onAdd(id: string): void })`.

There are no component tests in this repo; this task is verified by typecheck here and by the browser in Task 5.

- [ ] **Step 1: Create `ModelCard.tsx`**

```tsx
import type { CatalogModel } from '../../../shared/types';
import { CAPABILITIES, capabilitiesOf, isNew, UNUSED_HINT } from '../lib/catalog';
import { formatContext, formatPricePerM } from '../lib/format';

export interface ModelCardProps {
  model: CatalogModel;
  added: boolean;
  busy: boolean;
  onAdd(): void;
  /** Shelf variant: no description. */
  compact?: boolean;
}

/** Free and long context already show in the price and context line, so they get no pill. */
const PILLS = CAPABILITIES.filter((c) => c.id !== 'free' && c.id !== 'longContext');

export function ModelCard({ model: m, added, busy, onAdd, compact = false }: ModelCardProps) {
  const caps = capabilitiesOf(m);
  const pills = PILLS.filter((c) => caps.includes(c.id));
  return (
    <li className={`model-card${compact ? ' compact' : ''}`}>
      <div className="model-card-head">
        <span className="model-card-name" title={m.name}>{m.name}</span>
        {isNew(m) && <span className="badge">New</span>}
      </div>
      <code className="model-card-id" title={m.id}>{m.id}</code>
      <div className="model-card-stats">
        <span>{caps.includes('free') ? 'Free' : `${formatPricePerM(m.promptPrice)} in · ${formatPricePerM(m.completionPrice)} out`}</span>
        {m.contextLength !== null && <span>{formatContext(m.contextLength)} ctx</span>}
      </div>
      {pills.length > 0 && (
        <div className="pills">
          {pills.map((c) => (
            <span key={c.id} className={`pill${c.usedByOpenChat ? '' : ' unused'}`} title={c.usedByOpenChat ? undefined : UNUSED_HINT}>
              {c.label}
            </span>
          ))}
        </div>
      )}
      {!compact && m.description && <p className="model-card-desc" title={m.description}>{m.description}</p>}
      <button className="primary model-card-add" disabled={added || busy} onClick={onAdd}>
        {added ? 'Added' : 'Add'}
      </button>
    </li>
  );
}
```

- [ ] **Step 2: Create `CatalogFilters.tsx`**

```tsx
import { useState } from 'react';
import { CAPABILITIES, SORTS, UNUSED_HINT, type CatalogFilter, type SortKey } from '../lib/catalog';

export interface CatalogFiltersProps {
  filter: CatalogFilter;
  onFilter(next: CatalogFilter): void;
  sort: SortKey;
  onSort(next: SortKey): void;
  providers: { top: string[]; rest: string[] };
  loading: boolean;
  onRefresh(): void;
}

const toggle = <T,>(list: T[], item: T): T[] => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

export function CatalogFilters({ filter, onFilter, sort, onSort, providers, loading, onRefresh }: CatalogFiltersProps) {
  const [allProviders, setAllProviders] = useState(false);
  // Collapsed, selected providers from the long tail stay visible so they can be turned off.
  const extra = allProviders ? providers.rest : providers.rest.filter((p) => filter.providers.includes(p));
  const hiddenCount = providers.rest.length - extra.length;

  return (
    <div className="catalog-filters">
      <div className="filters">
        <input type="search" placeholder="Search models" value={filter.query} onChange={(e) => onFilter({ ...filter, query: e.target.value })} />
        <select value={sort} onChange={(e) => onSort(e.target.value as SortKey)} aria-label="Sort">
          {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <button onClick={onRefresh} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
      </div>

      <div className="chip-row" role="group" aria-label="Capabilities">
        <span className="chip-label">Can do</span>
        {CAPABILITIES.map((c) => {
          const on = filter.capabilities.includes(c.id);
          return (
            <button
              key={c.id}
              className={`chip${on ? ' on' : ''}${c.usedByOpenChat ? '' : ' unused'}`}
              aria-pressed={on}
              title={c.usedByOpenChat ? undefined : UNUSED_HINT}
              onClick={() => onFilter({ ...filter, capabilities: toggle(filter.capabilities, c.id) })}
            >
              {c.label}
            </button>
          );
        })}
        <span className="muted small">• {UNUSED_HINT.toLowerCase()}</span>
      </div>

      <div className="chip-row" role="group" aria-label="Providers">
        <span className="chip-label">Provider</span>
        {[...providers.top, ...extra].map((p) => {
          const on = filter.providers.includes(p);
          return (
            <button key={p} className={`chip${on ? ' on' : ''}`} aria-pressed={on} onClick={() => onFilter({ ...filter, providers: toggle(filter.providers, p) })}>
              {p}
            </button>
          );
        })}
        {hiddenCount > 0 && <button className="chip more" onClick={() => setAllProviders(true)}>+{hiddenCount}</button>}
        {allProviders && providers.rest.length > 0 && <button className="chip more" onClick={() => setAllProviders(false)}>Fewer</button>}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create `PopularShelf.tsx`**

```tsx
import { CATEGORIES, type CatalogModel, type Category } from '../../../shared/types';
import { ModelCard } from './ModelCard';

export interface PopularShelfProps {
  category: Category;
  onCategory(next: Category): void;
  /** Categories that have rankings, so the select never offers an empty one. */
  available: Category[];
  /** Already ranked and filtered (see popularFor). */
  models: CatalogModel[];
  added: Set<string>;
  busy: string | null;
  onAdd(id: string): void;
}

export function PopularShelf({ category, onCategory, available, models, added, busy, onAdd }: PopularShelfProps) {
  const label = CATEGORIES.find((c) => c.id === category)?.label ?? category;
  return (
    <section className="shelf">
      <div className="shelf-head">
        <h3>Popular for</h3>
        <select value={category} onChange={(e) => onCategory(e.target.value as Category)} aria-label="Category">
          {CATEGORIES.filter((c) => available.includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </div>
      {models.length === 0 ? (
        <p className="muted small">No popular {label} models match these filters.</p>
      ) : (
        <ul className="shelf-strip">
          {models.map((m) => (
            <ModelCard key={m.id} model={m} compact added={added.has(m.id)} busy={busy === m.id} onAdd={() => onAdd(m.id)} />
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Append the styles**

Append to the end of `web/src/styles.css`:

```css
/* Model browser */
.catalog-filters { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
.catalog-filters .filters { margin-bottom: 0; flex-wrap: wrap; }
.catalog-filters .filters input { min-width: 180px; }
.chip-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.chip-label { font-size: 13px; color: var(--muted); min-width: 64px; }
button.chip { background: var(--surface); }
button.chip.on { background: var(--accent); color: var(--accent-text); }
button.chip.more { border-style: dashed; color: var(--muted); }
.chip.unused::after, .pill.unused::after { content: '•'; margin-left: 2px; }
.chip.unused:not(.on), .pill.unused { opacity: 0.65; }
.model-grid { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
.model-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.model-card-head { display: flex; align-items: center; gap: 6px; }
.model-card-name { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-card-id { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-card-stats { display: flex; flex-wrap: wrap; gap: 2px 10px; font-size: 13px; color: var(--muted); }
.pills { display: flex; flex-wrap: wrap; gap: 4px; }
.pill { font-size: 12px; border: 1px solid var(--border); border-radius: 999px; padding: 0 8px; }
.model-card-desc { margin: 0; font-size: 13px; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.model-card-add { margin-top: auto; align-self: flex-start; }
.shelf { margin-bottom: 20px; }
.shelf-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.shelf-head h3 { font-size: 15px; margin: 0; }
.shelf-strip { list-style: none; padding: 0 0 6px; margin: 0; display: flex; gap: 10px; overflow-x: auto; scroll-snap-type: x proximity; }
.shelf-strip .model-card { flex: 0 0 220px; scroll-snap-align: start; }
.show-more { display: block; margin: 12px auto 0; }
@media (max-width: 600px) {
  .model-grid { grid-template-columns: 1fr; }
  .chip-label { min-width: 0; width: 100%; }
}
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exits 0 (components are not yet rendered anywhere; that's Task 5).

- [ ] **Step 6: Commit**

```bash
git add web/src/components/ModelCard.tsx web/src/components/CatalogFilters.tsx web/src/components/PopularShelf.tsx web/src/styles.css
git commit -m "feat(web): model card, catalog filter chips and popular shelf components"
```

---

### Task 5: Wire the browser into the Model Library page and verify it

**Files:**
- Modify: `web/src/pages/ModelLibrary.tsx` (imports, state, and the "Browse OpenRouter" section — lines 1-35 and 97-140; "My models" stays unchanged)

**Interfaces:**
- Consumes: `CatalogFilters`, `PopularShelf`, `ModelCard` (Task 4); `NO_FILTER`, `isFiltering`, `filterCatalog`, `sortCatalog`, `topProviders`, `popularFor`, `CatalogFilter`, `SortKey` (Task 3); `CATEGORIES`, `Category` (Task 1).
- Produces: the finished page.

- [ ] **Step 1: Replace imports, constants and browse state**

Replace lines 1-35 of `web/src/pages/ModelLibrary.tsx` (through the old `filtered` memo) with:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { CATEGORIES, type CatalogResponse, type Category, type LibraryModel } from '../../../shared/types';
import { api } from '../api';
import { CatalogFilters } from '../components/CatalogFilters';
import { ModelCard } from '../components/ModelCard';
import { PopularShelf } from '../components/PopularShelf';
import {
  filterCatalog, isFiltering, NO_FILTER, popularFor, sortCatalog, topProviders, type CatalogFilter, type SortKey,
} from '../lib/catalog';

export interface ModelLibraryProps {
  models: LibraryModel[];
  onChanged(): void;
}

const PAGE_SIZE = 60;
const TOP_PROVIDERS = 8;

export function ModelLibrary({ models, onChanged }: ModelLibraryProps) {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<CatalogFilter>(NO_FILTER);
  const [sort, setSort] = useState<SortKey>('cheapest');
  const [category, setCategory] = useState<Category>('programming');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = (refresh = false) => {
    setLoading(true);
    setCatalogError(null);
    api.catalog(refresh)
      .then(setCatalog)
      .catch((e: Error) => setCatalogError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => load(), []);
  useEffect(() => setLimit(PAGE_SIZE), [filter, sort]);

  const added = new Set(models.map((m) => m.id));
  const all = catalog?.models ?? [];
  const rankings = catalog?.rankings ?? {};
  const providers = useMemo(() => topProviders(all, TOP_PROVIDERS), [catalog]);
  const results = useMemo(() => sortCatalog(filterCatalog(all, filter), sort), [catalog, filter, sort]);
  const available = useMemo(() => CATEGORIES.map((c) => c.id).filter((id) => (rankings[id]?.length ?? 0) > 0), [catalog]);
  const shelfCategory: Category | undefined = available.includes(category) ? category : available[0];
  const popular = useMemo(
    () => (shelfCategory ? popularFor(all, rankings, shelfCategory, filter) : []),
    [catalog, shelfCategory, filter],
  );
  const showShelf = shelfCategory !== undefined && filter.query.trim() === '';
```

- [ ] **Step 2: Replace the "Browse OpenRouter" section**

Replace everything from `<h2>Browse OpenRouter</h2>` through the closing `</ul>` of the old catalog list with:

```tsx
        <h2>Browse OpenRouter</h2>
        <CatalogFilters
          filter={filter}
          onFilter={setFilter}
          sort={sort}
          onSort={setSort}
          providers={providers}
          loading={loading}
          onRefresh={() => load(true)}
        />
        {catalogError && (
          <p className="error-text">
            Couldn't load the catalog: {catalogError} <button className="link" onClick={() => load(true)}>Retry</button>
          </p>
        )}
        {catalog?.stale && <p className="muted small">Showing a cached catalog — OpenRouter couldn't be reached.</p>}

        {catalog && showShelf && shelfCategory && (
          <PopularShelf
            category={shelfCategory}
            onCategory={setCategory}
            available={available}
            models={popular}
            added={added}
            busy={busy}
            onAdd={(id) => act(id, () => api.addModel(id))}
          />
        )}

        {catalog && <p className="muted small">{results.length} models</p>}
        {catalog && results.length === 0 ? (
          <p className="muted">
            No models match.{' '}
            {isFiltering(filter) && <button className="link" onClick={() => setFilter(NO_FILTER)}>Clear filters</button>}
          </p>
        ) : (
          <ul className="model-grid">
            {results.slice(0, limit).map((m) => (
              <ModelCard key={m.id} model={m} added={added.has(m.id)} busy={busy === m.id} onAdd={() => act(m.id, () => api.addModel(m.id))} />
            ))}
          </ul>
        )}
        {results.length > limit && (
          <button className="show-more" onClick={() => setLimit((n) => n + PAGE_SIZE)}>Show more</button>
        )}
```

Step 1 already dropped the `formatContext` / `formatPricePerM` imports and `MAX_ROWS`; the old `query` / `provider` state is gone too, so nothing else in the file should reference them (typecheck in Step 3 confirms).

- [ ] **Step 3: Run tests and typecheck**

Run: `npm test` then `npm run typecheck`
Expected: all PASS; typecheck exits 0.

- [ ] **Step 4: Verify in the browser**

Start the app with the preview tool using the existing `.claude/launch.json` configuration named `openchat` (it runs `npm run dev`; the web app is on port 5173). Open the Model Library and check:

1. The cache upgrades: the first load after this change refetches (the network request for `/api/models/catalog` returns `rankings` with keys such as `programming`).
2. The default sort is Cheapest and the first cards are Free.
3. Click **Reasoning** then **Free**: every card shows "Free" and a Reasoning pill; the count drops.
4. Vision / Tools / File input chips are dimmed with a "•" and show the tooltip on hover.
5. Pick a provider chip, then **+N**: the long tail expands; selecting one there and clicking **Fewer** keeps it visible.
6. The shelf shows "Popular for Programming"; switching to Roleplay changes the cards; typing in search hides the shelf.
7. A filter combination with no shelf matches shows "No popular … models match these filters."; one with no grid matches shows "No models match" and **Clear filters** resets everything.
8. With more than 60 results, **Show more** adds cards; changing sort resets to 60.
9. Adding a card turns its button to "Added" in both the shelf and the grid, and the model appears under "My models".
10. Resize to mobile width: the grid becomes one column, the shelf scrolls horizontally, and nothing scrolls the page sideways. Check dark theme too.

Fix anything that fails, re-run step 3, and take a screenshot of the finished page.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/ModelLibrary.tsx
git commit -m "feat(web): faceted model browser with popular-by-category shelf in the Model Library"
```
