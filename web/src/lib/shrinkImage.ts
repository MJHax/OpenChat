import { ATTACHMENT_LIMITS } from '../../../shared/attachments';

const loadImage = (blob: Blob) => new Promise<HTMLImageElement>((resolve, reject) => {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
  img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't read that image.")); };
  img.src = url;
});

/**
 * An image small enough to attach: unchanged when it already fits, otherwise re-encoded as JPEG and scaled down by
 * 15% a step until it does. Browser-only (uses a canvas).
 */
export async function shrinkImage(file: Blob, maxBytes = ATTACHMENT_LIMITS.image): Promise<Blob> {
  if (file.size <= maxBytes) return file;
  const img = await loadImage(file);
  let width = img.naturalWidth;
  let height = img.naturalHeight;
  for (let i = 0; i < 12; i++) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width);
    canvas.height = Math.round(height);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (out && out.size <= maxBytes) return out;
    width *= 0.85;
    height *= 0.85;
  }
  throw new Error("That image is too large to attach, even scaled down.");
}

/** `file` shrunk to fit, as a File named .jpg when it had to be re-encoded. */
export async function shrinkFile(file: File): Promise<File> {
  const out = await shrinkImage(file);
  return out === file ? file : new File([out], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
}
