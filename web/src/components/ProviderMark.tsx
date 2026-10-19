/** A monogram tile for a model's provider, from the first part of its id ("anthropic/claude-…" → "A"). */
export function ProviderMark({ id }: { id: string }) {
  const provider = id.split('/')[0] ?? id;
  return <span className="provider-mark" aria-hidden>{(provider.replace(/^~/, '').charAt(0) || '?').toUpperCase()}</span>;
}
