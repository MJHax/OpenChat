import { parseFileBlocks } from '../../../shared/files';
import { FileCard } from './FileCard';
import { Markdown } from './Markdown';

interface Props {
  text: string;
  /** The saved reply; null while it streams. */
  messageId: string | null;
  streaming: boolean;
}

/** An assistant reply: Markdown text with each file block shown as a card where it was written. */
export function MessageBody({ text, messageId, streaming }: Props) {
  return (
    <>
      {parseFileBlocks(text).map((s, i) =>
        s.type === 'text'
          ? s.text.trim() && <Markdown key={i} text={s.text} />
          : <FileCard key={i} file={s.file} messageId={messageId} streaming={streaming} />,
      )}
    </>
  );
}
