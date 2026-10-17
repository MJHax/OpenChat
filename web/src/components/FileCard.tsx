import { useContext, type KeyboardEvent } from 'react';
import { fileKind, mimeFor, safeFileName, type FileBlock, type FileKind } from '../../../shared/files';
import { formatBytes } from '../lib/format';
import { FilePanelContext } from './FilePanelContext';
import { cardOpenable } from '../lib/filePanelState';

const LABELS: Record<FileKind, string> = { html: 'HTML', svg: 'SVG', md: 'MD', csv: 'CSV', code: 'CODE', other: 'FILE' };

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** Saves `file` from the browser, as-is. */
export function saveBlob(file: FileBlock, content = file.content): void {
  const url = URL.createObjectURL(new Blob([content], { type: mimeFor(file.name) }));
  const a = document.createElement('a');
  a.href = url;
  a.download = safeFileName(file.name);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface Props {
  file: FileBlock;
  messageId: string | null;
  streaming: boolean;
}

/** A file a reply produced: click to open it in the side panel. */
export function FileCard({ file, messageId, streaming }: Props) {
  const context = useContext(FilePanelContext);
  const panel = cardOpenable(file, streaming) ? context : null;
  const kind = fileKind(file.name);
  const writing = !file.complete && streaming;
  const version = writing ? null : context?.versionOf(file.name, messageId) ?? null;
  const size = formatBytes(byteLength(file.content));
  const open = () => panel?.open(file.name, messageId, file);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  };

  return (
    <div
      className={`file-card${panel ? ' clickable' : ''}`}
      role={panel ? 'button' : undefined}
      tabIndex={panel ? 0 : undefined}
      onClick={open}
      onKeyDown={panel ? onKey : undefined}
      title={panel ? 'Open' : undefined}
    >
      <span className={`file-icon kind-${kind}`}>{LABELS[kind]}</span>
      <span className="file-info">
        <span className="file-name">{writing ? `Writing ${file.name}…` : file.name}</span>
        <span className="muted small">
          {size}
          {version !== null && version > 1 && ` · v${version}`}
          {!file.complete && !streaming && ' · Incomplete'}
        </span>
      </span>
      {!writing && (
        <button
          className="link"
          onClick={(e) => { e.stopPropagation(); if (context) context.download(file); else saveBlob(file); }}
          aria-label={`Download ${file.name}`}
        >
          Download
        </button>
      )}
    </div>
  );
}
