import { Download, FileCode, FileText, MessageSquarePlus, Play } from 'lucide-react';
import type { LibraryItem } from '../../../../shared/types';
import { librarySrc } from '../../api';
import { ChatsBadge } from './ChatsBadge';
import { isSvgName } from '../../lib/svg';

const extension = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toUpperCase() : '');

/** The picture at the top of a tile: the image itself, a video's first frame, or an icon for documents and code. */
function Thumb({ item }: { item: LibraryItem }) {
  if (item.type === 'image') return <img src={librarySrc(item.source)} alt="" loading="lazy" className={isSvgName(item.name) ? 'svg-image' : undefined} />;
  if (item.type === 'video') {
    return (
      <>
        <video src={librarySrc(item.source)} preload="metadata" muted playsInline />
        <span className="lib-play" aria-hidden><Play size={18} /></span>
      </>
    );
  }
  const Icon = item.type === 'code' ? FileCode : FileText;
  return <span className="lib-icon"><Icon size={26} /><small>{extension(item.name)}</small></span>;
}

/** One file in the Library grid. */
export function LibraryTile({ item, busy, onOpen, onReuse }: { item: LibraryItem; busy: boolean; onOpen(): void; onReuse?(): void }) {
  return (
    <div className="lib-tile">
      <button type="button" className="lib-thumb" onClick={onOpen} aria-label={`Preview ${item.name}`}><Thumb item={item} /></button>
      <div className="lib-actions">
        <a className="lib-act" href={librarySrc(item.source)} download={item.name} title="Download" aria-label={`Download ${item.name}`}>
          <Download size={14} />
        </a>
        {onReuse && (
          <button type="button" className="lib-act" onClick={onReuse} disabled={busy} title="Start a new chat with this file">
            <MessageSquarePlus size={14} /> {busy ? 'Adding…' : 'New chat'}
          </button>
        )}
      </div>
      <div className="lib-meta">
        <span className="lib-name" title={item.name}>{item.name}</span>
        <ChatsBadge chats={item.chats} />
      </div>
    </div>
  );
}
