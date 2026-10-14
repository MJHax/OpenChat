import type { CatalogModel } from '../../../shared/types';

export const providerOf = (id: string): string => id.replace(/^~/, '').split('/')[0];

export function filterCatalog(models: CatalogModel[], query: string, provider: string): CatalogModel[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return models.filter((m) => {
    if (provider && providerOf(m.id) !== provider) return false;
    const haystack = `${m.id} ${m.name}`.toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}
