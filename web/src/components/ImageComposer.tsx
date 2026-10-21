import { NEEDS_KEY } from '../lib/needsKey';
import { useRef } from 'react';
import { canGenerate, estimateImageCost, snapSettings, type ImageModel, type ImageSettings } from '../../../shared/imageModels';
import type { Attachment, MediaLibraryModel } from '../../../shared/types';
import { attachmentUrl } from '../api';
import { money } from '../lib/imagePrice';
import { Paperclip, X } from 'lucide-react';

interface Props {
  library: MediaLibraryModel[];
  model: ImageModel | null;
  onModelChange(id: string): void;
  settings: ImageSettings;
  onSettings(s: ImageSettings): void;
  prompt: string;
  onPrompt(p: string): void;
  uploads: Attachment[];
  uploading: boolean;
  onFiles(files: File[]): void;
  onRemoveUpload(id: string): void;
  /** "Editing the image above" / "Editing image 2"; null for a new image. */
  editNote: string | null;
  /** Whether the thread has an image an edit would target (shows the "New image instead" toggle). */
  hasTarget: boolean;
  newImage: boolean;
  onNewImage(on: boolean): void;
  /** How many images the request would send as references. */
  refs: number;
  /** Something outside the composer that stops a send (no key, already generating). */
  blocked: string | null;
  onGenerate(): void;
}

/** Prompt, photos, model and settings for the next image, with its price on the button. */
export function ImageComposer(p: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const m = p.model;
  const entry = p.library.find((e) => e.id === m?.id);
  const avg = entry?.avgCost[`${p.settings.size ?? ''}|${p.settings.quality ?? ''}`] ?? null;
  const price = m ? estimateImageCost(m, p.settings, avg) : null;
  const reason = p.blocked
    ?? (!m ? 'Add an image model in the Model Library first.' : null)
    ?? (m ? canGenerate(m, p.refs) : null)
    ?? (!p.prompt.trim() && p.uploads.length === 0 ? '' : null);
  const set = (change: Partial<ImageSettings>) => m && p.onSettings(snapSettings(m, { ...p.settings, ...change }));

  return (
    <div className="composer">
      <div className="composer-box image-composer">
        {p.editNote && !p.newImage && <div className="edit-note small">{p.editNote}</div>}
        {p.uploads.length > 0 && (
          <div className="upload-thumbs">
            {p.uploads.map((a) => (
              <span key={a.id} className="upload-thumb">
                <img src={attachmentUrl(a.id)} alt={a.filename} />
                <button className="icon" aria-label={`Remove ${a.filename}`} onClick={() => p.onRemoveUpload(a.id)}><X size={12} /></button>
              </span>
            ))}
          </div>
        )}
        <textarea
          rows={2}
          placeholder={p.editNote && !p.newImage ? 'Describe a change…' : 'Describe an image, or attach a photo to edit…'}
          value={p.prompt}
          onChange={(e) => p.onPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && reason === null) { e.preventDefault(); p.onGenerate(); } }}
        />
        <div className="row image-controls">
          <button className="icon-btn" aria-label="Attach photo" title="Attach photo" disabled={p.uploading} onClick={() => fileInput.current?.click()}><Paperclip size={16} /></button>
          <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => { p.onFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
          <select aria-label="Image model" value={m?.id ?? ''} onChange={(e) => p.onModelChange(e.target.value)} disabled={p.library.length === 0}>
            {p.library.length === 0 && <option value="">No image models</option>}
            {p.library.map((e) => <option key={e.id} value={e.id}>{e.displayName}{(e.model as ImageModel | null)?.svg ? ' · SVG' : ''}</option>)}
          </select>
          {m && m.aspects.length > 0 && (
            <select aria-label="Aspect ratio" value={p.settings.aspect} onChange={(e) => set({ aspect: e.target.value })}>
              {m.aspects.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          )}
          {m && m.resolutions.length > 0 && (
            <select aria-label="Size" value={p.settings.size ?? ''} onChange={(e) => set({ size: e.target.value })}>
              {m.resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          )}
          {m && m.qualities.length > 0 && (
            <select aria-label="Quality" value={p.settings.quality ?? ''} onChange={(e) => set({ quality: e.target.value })}>
              {m.qualities.map((q) => <option key={q} value={q}>{q}</option>)}
            </select>
          )}
          {m?.transparent && (
            <button className="chip ghost toggle-chip" aria-pressed={p.settings.transparent} onClick={() => set({ transparent: !p.settings.transparent })}>Transparent</button>
          )}
          {p.hasTarget && (
            <button className="chip ghost toggle-chip" aria-pressed={p.newImage} onClick={() => p.onNewImage(!p.newImage)} title="Make a new image instead of editing">
              New image instead
            </button>
          )}
          <span className="spacer" />
          <button className="primary" disabled={reason !== null || p.uploading} onClick={p.onGenerate}>
            Generate{price?.cost != null ? ` · ${price.estimated ? '~' : ''}${money(price.cost)}` : ''}
          </button>
        </div>
        {reason && <div className="composer-hint">{reason === NEEDS_KEY ? <a href="#/settings">{reason}</a> : reason}</div>}
      </div>
    </div>
  );
}
