import { useEffect, useState } from 'react';
import type { Attachment } from '../../../shared/types';
import { attachmentUrl } from '../api';

// Images never change once uploaded, so their data URLs are kept for the whole session.
const cache = new Map<string, Promise<string>>();

function dataUrlOf(id: string): Promise<string> {
  let p = cache.get(id);
  if (!p) {
    p = fetch(attachmentUrl(id))
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((blob) => new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      }));
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return p;
}

/** The chat's images as file name → data URL, so generated pages can show them by name. */
export function useChatImages(images: Attachment[]): Map<string, string> {
  const [map, setMap] = useState<Map<string, string>>(new Map());
  const key = images.map((a) => a.id).join(',');
  useEffect(() => {
    let current = true;
    Promise.all(images.map((a) => dataUrlOf(a.id).then((url) => [a.filename, url] as const).catch(() => null)))
      .then((pairs) => { if (current) setMap(new Map(pairs.filter((p): p is readonly [string, string] => p !== null))); });
    return () => { current = false; };
  }, [key]);
  return map;
}
