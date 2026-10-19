/**
 * Which image the next message edits, and the note that says so. A picked image ("Edit this") stays the target even off
 * the current branch (the server accepts any image in the thread); attaching a photo replaces the default (latest) target
 * rather than adding to it; "New image instead" clears it.
 */
export function editTarget(o: { picked: string | null; newImage: boolean; uploads: number; onPath: string[] }): { id: string | null; note: string | null } {
  if (o.newImage) return { id: null, note: null };
  if (o.picked) {
    const index = o.onPath.indexOf(o.picked);
    const latest = index === o.onPath.length - 1;
    return { id: o.picked, note: index === -1 ? 'Editing an image from another version' : latest ? 'Editing the image above' : `Editing image ${index + 1}` };
  }
  if (o.uploads > 0) return { id: null, note: o.uploads === 1 ? 'Editing your photo' : 'Editing your photos' };
  const latest = o.onPath.at(-1);
  return latest ? { id: latest, note: 'Editing the image above' } : { id: null, note: null };
}
