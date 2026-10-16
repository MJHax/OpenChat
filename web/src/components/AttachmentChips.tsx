import { attachmentUrl } from '../api';
import { formatBytes } from '../lib/format';
import type { DraftAttachment } from './useAttachmentDraft';

interface Props {
  items: DraftAttachment[];
  /** Shown in a sent message: larger thumbnails, each opens in a new tab, nothing removable. */
  inMessage?: boolean;
  onRemove?(key: string): void;
}

const ICON: Record<DraftAttachment['kind'], string> = { image: 'IMG', pdf: 'PDF', text: 'TXT' };

export function AttachmentChips({ items, inMessage = false, onRemove }: Props) {
  if (items.length === 0) return null;
  return (
    <div className={`attachments${inMessage ? ' in-message' : ''}`}>
      {items.map((item) => {
        const body = (
          <>
            {item.previewUrl && item.status !== 'error' ? (
              <img className="attachment-thumb" src={item.previewUrl} alt="" />
            ) : (
              <span className="attachment-icon" aria-hidden>{ICON[item.kind]}</span>
            )}
            <span className="attachment-text">
              <span className="attachment-name">{item.name}</span>
              <span className={item.error ? 'attachment-error' : 'attachment-size'}>
                {item.error ?? (item.status === 'uploading' ? `Uploading ${Math.round(item.progress * 100)}%` : formatBytes(item.size))}
              </span>
            </span>
          </>
        );
        return (
          <div key={item.key} className={`attachment ${item.kind}${item.status === 'error' ? ' failed' : ''}`} title={item.name}>
            {inMessage && item.attachment ? (
              <a className="attachment-link" href={attachmentUrl(item.attachment.id)} target="_blank" rel="noreferrer">{body}</a>
            ) : body}
            {onRemove && (
              <button className="attachment-remove" aria-label={`Remove ${item.name}`} onClick={() => onRemove(item.key)}>×</button>
            )}
          </div>
        );
      })}
    </div>
  );
}
