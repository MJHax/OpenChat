import { useEffect } from 'react';
import type { Attachment } from '../../../shared/types';
import { attachmentUrl } from '../api';

interface Props {
  image: Attachment;
  onEdit?(): void;
  onAgain?(): void;
  onClose(): void;
}

/** One image full size, with the same actions as under it in the thread. */
export function Lightbox({ image, onEdit, onAgain, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-label={image.filename} onClick={onClose}>
      <img src={attachmentUrl(image.id)} alt={image.filename} onClick={(e) => e.stopPropagation()} />
      <div className="lightbox-actions" onClick={(e) => e.stopPropagation()}>
        <a className="button" href={attachmentUrl(image.id)} download={image.filename}>Download</a>
        {onEdit && <button onClick={() => { onEdit(); onClose(); }}>Edit this</button>}
        {onAgain && <button onClick={() => { onAgain(); onClose(); }}>Again</button>}
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
