import { useEffect, useRef, useState } from 'react';
import type { Attachment, AttachmentKind } from '../../../shared/types';
import { attachmentUrl, deleteAttachment, uploadAttachment } from '../api';
import { addError, guessKind } from '../lib/attachments';

export interface DraftAttachment {
  key: string;
  name: string;
  size: number;
  kind: AttachmentKind;
  status: 'uploading' | 'ready' | 'error';
  progress: number;
  error: string | null;
  attachment: Attachment | null;
  /** Thumbnail source for images: a blob URL while drafting, the server URL once sent. */
  previewUrl: string | null;
  /** Already part of a sent message (an edit's starting list); never deleted from the server here. */
  sent: boolean;
}

let nextKey = 0;

/** A sent attachment as a chip. */
export const toDraft = (a: Attachment): DraftAttachment => ({
  key: a.id, name: a.filename, size: a.size, kind: a.kind, status: 'ready', progress: 1, error: null, attachment: a,
  previewUrl: a.kind === 'image' ? attachmentUrl(a.id) : null, sent: true,
});

const revoke = (item: DraftAttachment) => {
  if (item.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(item.previewUrl);
};

/** Files being attached in the composer or an edit box: each uploads as soon as it is added. */
export function useAttachmentDraft() {
  const [items, setItems] = useState<DraftAttachment[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const uploads = useRef(new Map<string, AbortController>());

  const update = (key: string, change: Partial<DraftAttachment>) =>
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...change } : i)));

  // Revoke thumbnails and stop uploads when the composer or edit box goes away.
  useEffect(() => () => {
    itemsRef.current.forEach(revoke);
    uploads.current.forEach((c) => c.abort());
  }, []);

  function add(files: FileList | File[]) {
    const counted = itemsRef.current.filter((i) => i.status !== 'error');
    const added: DraftAttachment[] = [];
    for (const file of Array.from(files)) {
      const key = `draft-${nextKey++}`;
      const kind = guessKind(file);
      const error = addError(counted, file);
      const item: DraftAttachment = {
        key, name: file.name || 'file', size: file.size, kind, status: error ? 'error' : 'uploading', progress: 0, error,
        attachment: null, previewUrl: kind === 'image' && !error ? URL.createObjectURL(file) : null, sent: false,
      };
      added.push(item);
      if (error) continue;
      counted.push(item);
      const controller = new AbortController();
      uploads.current.set(key, controller);
      uploadAttachment(file, (progress) => update(key, { progress }), controller.signal)
        .then((attachment) => update(key, { status: 'ready', progress: 1, attachment, kind: attachment.kind }))
        .catch((e: Error) => { if (e.name !== 'AbortError') update(key, { status: 'error', error: e.message }); })
        .finally(() => uploads.current.delete(key));
    }
    setItems((list) => [...list, ...added]);
  }

  function remove(key: string) {
    const item = itemsRef.current.find((i) => i.key === key);
    if (!item) return;
    uploads.current.get(key)?.abort();
    if (item.attachment && !item.sent) deleteAttachment(item.attachment.id).catch(() => {});
    revoke(item);
    setItems((list) => list.filter((i) => i.key !== key));
  }

  /** Empties the draft after a send: the uploads now belong to the message. */
  function clear() {
    itemsRef.current.forEach(revoke);
    setItems([]);
  }

  /** Empties the draft and deletes its unsent uploads (e.g. an edit was cancelled). */
  function discard() {
    itemsRef.current.forEach((i) => remove(i.key));
    setItems([]);
  }

  /** Starts over from a sent message's attachments (opening an edit box). */
  function reset(list: Attachment[]) {
    itemsRef.current.forEach(revoke);
    setItems(list.map(toDraft));
  }

  const ready = items.filter((i) => i.status === 'ready' && i.attachment).map((i) => i.attachment!);
  return {
    items,
    add,
    remove,
    clear,
    discard,
    reset,
    /** Attachments ready to send, in order. */
    ready,
    uploading: items.some((i) => i.status === 'uploading'),
    kinds: items.filter((i) => i.status !== 'error').map((i) => i.kind),
  };
}
