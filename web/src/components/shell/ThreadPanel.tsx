import { useEffect, useState } from 'react';
import { Clapperboard, PanelLeftClose, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import type { ChatSummary, SearchHit, ThreadKind } from '../../../../shared/types';
import { api, attachmentUrl } from '../../api';
import { groupByDate, splitSnippet } from '../../lib/format';
import { navigate, threadHome, threadHref } from '../../lib/route';
import { forgetChatPrefs } from '../../lib/chatPrefs';
import { UsageCard } from './UsageCard';

export interface ThreadPanelProps {
  /** Which threads the list shows. */
  mode: ThreadKind;
  chats: ChatSummary[];
  activeChatId: string | null;
  onChatsChanged(): void;
  onOpenChat(chatId: string, kind: ThreadKind): void;
  onCollapse(): void;
  onOpenPalette(): void;
}

const TITLE: Record<ThreadKind, string> = { chat: 'Chats', image: 'Images', video: 'Video', discussion: 'Discussions' };
const NEW_LABEL: Record<ThreadKind, string> = { chat: 'New chat', image: 'New image', video: 'New video', discussion: 'New discussion' };

/** The list of threads for the current mode, beside the rail. */
export function ThreadPanel({ mode, chats, activeChatId, onChatsChanged, onOpenChat, onCollapse, onOpenPalette }: ThreadPanelProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      return;
    }
    const timer = setTimeout(() => {
      api.search(q).then(setHits).catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  async function openHit(hit: SearchHit) {
    await api.selectMessage(hit.chatId, hit.messageId).catch(() => {});
    setQuery('');
    onOpenChat(hit.chatId, hit.chatKind);
  }

  async function commitRename(chat: ChatSummary) {
    if (renaming !== chat.id) return; // Enter and blur can both fire
    setRenaming(null);
    const title = draft.trim();
    if (title && title !== chat.title) {
      await api.renameChat(chat.id, title).catch(() => {});
      onChatsChanged();
    }
  }

  async function remove(chat: ChatSummary) {
    if (!window.confirm(`Delete "${chat.title}"? This cannot be undone.`)) return;
    await api.deleteChat(chat.id).then(() => forgetChatPrefs([chat.id])).catch(() => {});
    if (chat.id === activeChatId) navigate(threadHome(mode));
    onChatsChanged();
  }

  const newLabel = NEW_LABEL[mode];

  return (
    <aside className="threads" aria-label={TITLE[mode]}>
      <div className="threads-head">
        <h2>{TITLE[mode]}</h2>
        <button className="icon-btn" onClick={() => navigate(threadHome(mode))} aria-label={newLabel} title={newLabel}><Plus size={16} /></button>
        <button className="icon-btn" onClick={onCollapse} aria-label="Collapse panel" title="Collapse panel (Ctrl+B)"><PanelLeftClose size={16} /></button>
      </div>
      <label className="thread-search">
        <Search size={14} />
        <input type="search" placeholder="Search or jump to…" value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'k' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onOpenPalette(); } }} />
        <kbd>Ctrl K</kbd>
      </label>

      <nav className="thread-list">
        {query.trim() ? (
          hits.length ? (
            hits.map((hit) => (
              <button key={hit.messageId} className="hit" onClick={() => openHit(hit)}>
                <div className="hit-title">{hit.chatTitle}</div>
                <div className="hit-snippet">
                  {splitSnippet(hit.snippet).map((part, i) => (part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>))}
                </div>
              </button>
            ))
          ) : (
            <div className="muted pad">No matches</div>
          )
        ) : (
          groupByDate(chats).map((group) => (
            <div key={group.label}>
              <div className="group-label">{group.label}</div>
              {group.items.map((chat) =>
                renaming === chat.id ? (
                  <input
                    key={chat.id}
                    className="rename"
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(chat);
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                    onBlur={() => commitRename(chat)}
                  />
                ) : (
                  <div key={chat.id} className={`thread-item${chat.id === activeChatId ? ' active' : ''}`}>
                    <a href={threadHref(chat.kind, chat.id)} title={chat.title}>
                      {(chat.kind === 'image' || chat.kind === 'video') && (
                        <span className="thread-thumb">
                          {chat.thumbnailId ? <img src={attachmentUrl(chat.thumbnailId)} alt="" /> : chat.kind === 'video' ? <Clapperboard size={14} /> : null}
                        </span>
                      )}
                      <span className="chat-title">{chat.title}</span>
                      {chat.busy && <span className="busy-dot fill" aria-label="Generating" />}
                    </a>
                    <span className="thread-actions">
                      <button className="icon" aria-label="Rename chat" title="Rename" onClick={() => { setRenaming(chat.id); setDraft(chat.title); }}><Pencil size={14} /></button>
                      <button className="icon" aria-label="Delete chat" title="Delete" onClick={() => remove(chat)}><Trash2 size={14} /></button>
                    </span>
                  </div>
                ),
              )}
            </div>
          ))
        )}
      </nav>

      <UsageCard refreshKey={chats} />
    </aside>
  );
}
