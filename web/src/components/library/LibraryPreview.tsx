import { useEffect, useState } from 'react';
import type { LibraryItem } from '../../../../shared/types';
import { librarySrc } from '../../api';
import { isSvgName } from '../../lib/svg';
import { CopySvgButton } from '../CopySvgButton';

/** A Library file at full size: the image, the clip playing, the PDF, or the text of a document or code file. */
export function LibraryPreview({ item, busy, onReuse, onClose }: { item: LibraryItem; busy: boolean; onReuse?(): void; onClose(): void }) {
  const src = librarySrc(item.source);
  const isPdf = item.source.type === 'attachment' && item.source.kind === 'pdf';
  const isText = (item.type === 'doc' || item.type === 'code') && !isPdf;
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    if (!isText) return;
    let current = true;
    fetch(src).then((r) => r.text()).then((t) => current && setText(t)).catch(() => current && setText("Couldn't load this file."));
    return () => { current = false; };
  }, [src, isText]);

  return (
    <div className="lightbox lib-preview" role="dialog" aria-label={item.name} onClick={onClose}>
      <div className="lib-preview-body" onClick={(e) => e.stopPropagation()}>
        {item.type === 'image' && <img src={src} alt={item.name} className={isSvgName(item.name) ? 'svg-image' : undefined} />}
        {item.type === 'video' && <video src={src} controls autoPlay playsInline />}
        {isPdf && <iframe src={src} title={item.name} />}
        {isText && <pre className="lib-text">{text ?? 'Loading…'}</pre>}
      </div>
      <div className="lightbox-actions" onClick={(e) => e.stopPropagation()}>
        <span className="lib-preview-name">{item.name}</span>
        <a className="button" href={src} download={item.name}>Download</a>
        {item.type === 'image' && isSvgName(item.name) && <CopySvgButton src={src} />}
        {onReuse && <button onClick={onReuse} disabled={busy}>{busy ? 'Adding…' : 'New chat'}</button>}
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
