import { useRef, useState, type DragEvent } from 'react';
import type { Attachment } from '../../../shared/types';
import { attachmentUrl, uploadAttachment } from '../api';
import { shrinkFile } from '../lib/shrinkImage';
import { GeneratedPicker } from './GeneratedPicker';
import { usePopover } from './usePopover';
import { X } from 'lucide-react';

interface Props {
  label: 'Start' | 'End';
  photo: Attachment | null;
  onPhoto(a: Attachment | null): void;
  /** Width ÷ height once the photo has loaded, so the clip's shape can follow it. */
  onAspect?(ratio: number): void;
  /** Why the slot is off for this model; null when it can be used. */
  disabledReason: string | null;
  onError(message: string): void;
}

/** A start or end photo for a clip: from this computer, or an image OpenChat made. */
export function FrameSlot({ label, photo, onPhoto, onAspect, disabledReason, onError }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const { open, setOpen, root } = usePopover();
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    setBusy(true);
    try {
      onPhoto(await uploadAttachment(await shrinkFile(file), () => {}));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const [dragging, setDragging] = useState(false);
  const drop = {
    onDragOver: (e: DragEvent) => {
      if (disabledReason || !Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (e: DragEvent) => {
      setDragging(false);
      const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith('image/'));
      if (disabledReason || !file) return;
      e.preventDefault();
      void upload(file);
    },
  };

  return (
    <div className={`frame-slot${disabledReason ? ' off' : ''}${dragging ? ' dragging' : ''}`} ref={root} title={disabledReason ?? undefined} {...drop}>
      {photo ? (
        <>
          <img src={attachmentUrl(photo.id)} alt={`${label} photo`} onLoad={(e) => onAspect?.(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)} />
          <button className="icon frame-remove" aria-label={`Remove ${label.toLowerCase()} photo`} onClick={() => onPhoto(null)}><X size={12} /></button>
        </>
      ) : (
        <button className="frame-empty" disabled={!!disabledReason || busy} onClick={() => setOpen(!open)} aria-haspopup="menu">
          {busy ? 'Uploading…' : `${label} photo`}
        </button>
      )}
      <span className="frame-label small muted">{label}</span>
      {open && (
        <div className="attach-options" role="menu">
          <button role="menuitem" onClick={() => { setOpen(false); input.current?.click(); }}>From this computer</button>
          <button role="menuitem" onClick={() => { setOpen(false); setPicking(true); }}>From my images</button>
        </div>
      )}
      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f); }} />
      {picking && (
        <GeneratedPicker imagesOnly onAttachments={(list) => onPhoto(list[0] ?? null)} onFiles={(files) => { if (files[0]) void upload(files[0]); }}
          onClose={() => setPicking(false)} />
      )}
    </div>
  );
}
