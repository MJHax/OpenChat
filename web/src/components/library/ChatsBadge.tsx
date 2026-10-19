import type { LibraryChatRef } from '../../../../shared/types';
import { navigate, threadHref } from '../../lib/route';
import { ChipPopover } from '../ChipPopover';

const day = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** Where a file is: its chat as a link, or "N chats ▾" listing each one to pick from. */
export function ChatsBadge({ chats }: { chats: LibraryChatRef[] }) {
  if (chats.length === 1) {
    const c = chats[0];
    return <a className="lib-chat" href={threadHref(c.kind, c.chatId)} onClick={(e) => e.stopPropagation()}>{c.title}</a>;
  }
  return (
    <span className="lib-chats" onClick={(e) => e.stopPropagation()}>
      <ChipPopover label={`${chats.length} chats ▾`} title="Chats this file is in" placement="down" className="lib-badge" panelClassName="lib-chats-panel">
        {(close) => (
          <ul className="lib-chat-list">
            {chats.map((c) => (
              <li key={c.chatId}>
                <button type="button" onClick={() => { close(); navigate(threadHref(c.kind, c.chatId)); }}>
                  <span className="lib-chat-title">{c.title}</span>
                  <span className="muted small">{day(c.at)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </ChipPopover>
    </span>
  );
}
