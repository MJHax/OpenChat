import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';

/** Paperclip that opens the system file picker. */
export function AttachButton({ onFiles }: { onFiles(files: File[]): void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button className="attach-btn" type="button" title="Attach images, PDFs or text files" aria-label="Attach files" onClick={() => input.current?.click()}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onFiles(Array.from(e.target.files));
          e.target.value = ''; // picking the same file again still fires
        }}
      />
    </>
  );
}

/** Drag-and-drop onto a box, and pasting files (e.g. a screenshot) into its textarea. */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false);
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  return {
    dragging,
    handlers: {
      onDragOver: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragging(true);
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      },
      onDrop: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragging(false);
        onFiles(Array.from(e.dataTransfer.files));
      },
    },
    // Text wins: copying from an office app often puts both text and a picture of it on the clipboard.
    onPaste: (e: ClipboardEvent) => {
      if (e.clipboardData.files.length === 0 || e.clipboardData.getData('text/plain')) return;
      e.preventDefault();
      onFiles(Array.from(e.clipboardData.files));
    },
  };
}
