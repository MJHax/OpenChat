import type { CatalogModel, CatalogResponse, Category } from '../../../shared/types';

export const providerOf = (id: string): string => id.replace(/^~/, '').split('/')[0];

export type Capability = 'reasoning' | 'free' | 'longContext' | 'vision' | 'tools' | 'file';

export const CAPABILITIES: { id: Capability; label: string; usedByOpenChat: boolean }[] = [
  { id: 'reasoning', label: 'Reasoning', usedByOpenChat: true },
  { id: 'free', label: 'Free', usedByOpenChat: true },
  { id: 'longContext', label: 'Long context', usedByOpenChat: true },
  { id: 'vision', label: 'Vision', usedByOpenChat: true },
  { id: 'tools', label: 'Tools', usedByOpenChat: false },
  { id: 'file', label: 'File input', usedByOpenChat: true },
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

/**
 * The provider chips to show. Collapsed, selected providers from the long tail stay visible so they can be
 * turned off, as does a selected provider a refresh dropped from the catalog.
 */
export function providerChips(
  providers: { top: string[]; rest: string[] },
  selected: string[],
  expanded: boolean,
): { chips: string[]; hiddenCount: number } {
  const extra = expanded ? providers.rest : providers.rest.filter((p) => selected.includes(p));
  const known = new Set([...providers.top, ...providers.rest]);
  return {
    chips: [...providers.top, ...extra, ...selected.filter((p) => !known.has(p))],
    hiddenCount: providers.rest.length - extra.length,
  };
}

export const countLabel = (n: number): string => `${n.toLocaleString('en-US')} ${n === 1 ? 'model' : 'models'}`;

/** Each call starts a request and returns a check that stays true until a newer request starts. */
export function latestOnly(): () => () => boolean {
  let current = 0;
  return () => {
    const id = ++current;
    return () => id === current;
  };
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
