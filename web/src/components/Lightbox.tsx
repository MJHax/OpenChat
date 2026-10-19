import { useEffect } from 'react';
import type { Attachment } from '../../../shared/types';
import { attachmentUrl } from '../api';
import { isSvgAttachment } from '../lib/svg';
import { CopySvgButton } from './CopySvgButton';

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
  const svg = isSvgAttachment(image);
  return (
    <div className="lightbox" role="dialog" aria-label={image.filename} onClick={onClose}>
      <img src={attachmentUrl(image.id)} alt={image.filename} className={svg ? 'svg-image' : undefined} onClick={(e) => e.stopPropagation()} />
      <div className="lightbox-actions" onClick={(e) => e.stopPropagation()}>
        <a className="button" href={attachmentUrl(image.id)} download={image.filename}>Download</a>
        {svg && <CopySvgButton src={attachmentUrl(image.id)} />}
        {onEdit && <button onClick={() => { onEdit(); onClose(); }}>Edit this</button>}
        {onAgain && <button onClick={() => { onAgain(); onClose(); }}>Again</button>}
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
