import { useEffect, useState } from 'react';
import type { ChatSummary, SearchHit, ThreadKind } from '../../../shared/types';
import { api, attachmentUrl } from '../api';
import { Segmented } from './stats/Segmented';
import { groupByDate, splitSnippet } from '../lib/format';
import { navigate } from '../lib/route';
import { forgetChatPrefs } from '../lib/chatPrefs';

export interface SidebarProps {
  /** Which threads the list shows: chats or image threads. */
  mode: ThreadKind;
  chats: ChatSummary[];
  activeChatId: string | null;
  onChatsChanged(): void;
  onOpenChat(chatId: string, kind: ThreadKind): void;
}

const MODES: { id: ThreadKind; label: string }[] = [
  { id: 'chat', label: 'Chats' }, { id: 'image', label: 'Images' }, { id: 'video', label: 'Video' }, { id: 'discussion', label: 'Discussions' },
];
const NEW_LABEL: Record<ThreadKind, string> = { chat: 'New chat', image: 'New image', video: 'New video', discussion: 'New discussion' };
const HOME: Record<ThreadKind, string> = { chat: '#/', image: '#/images', video: '#/video', discussion: '#/discussions' };
export const threadHref = (kind: ThreadKind, id: string) => (kind === 'chat' ? `#/chat/${id}` : `${HOME[kind]}/${id}`);

export function Sidebar({ mode, chats, activeChatId, onChatsChanged, onOpenChat }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
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
    if (chat.id === activeChatId) navigate(HOME[mode]);
    onChatsChanged();
  }

  const newLabel = NEW_LABEL[mode];

  if (collapsed) {
    return (
      <aside className="sidebar collapsed">
        <button className="icon" onClick={() => setCollapsed(false)} aria-label="Expand sidebar" title="Expand sidebar">☰</button>
        <button className="icon" onClick={() => navigate(HOME[mode])} aria-label={newLabel} title={newLabel}>＋</button>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <span className="brand">OpenChat</span>
        <button className="icon" onClick={() => setCollapsed(true)} aria-label="Collapse sidebar" title="Collapse sidebar">⟨</button>
      </div>
      <Segmented label="Mode" options={MODES} value={mode} onChange={(m) => navigate(HOME[m])} />
      <button className="new-chat" onClick={() => navigate(HOME[mode])}>＋ {newLabel}</button>
      <input className="search" type="search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />

      <nav className="chat-list">
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
                  <div key={chat.id} className={`chat-item${chat.id === activeChatId ? ' active' : ''}`}>
                    <a href={threadHref(chat.kind, chat.id)} title={chat.title}>
                      {(chat.kind === 'image' || chat.kind === 'video') && (
                        <span className="thread-thumb">
                          {chat.thumbnailId ? <img src={attachmentUrl(chat.thumbnailId)} alt="" /> : chat.kind === 'video' ? '🎬' : null}
                        </span>
                      )}
                      <span className="chat-title">{chat.title}</span>
                      {chat.busy && <span className="spinner" aria-label="Generating" />}
                    </a>
                    <span className="chat-actions">
                      <button className="icon" aria-label="Rename chat" title="Rename" onClick={() => { setRenaming(chat.id); setDraft(chat.title); }}>✎</button>
                      <button className="icon" aria-label="Delete chat" title="Delete" onClick={() => remove(chat)}>🗑</button>
                    </span>
                  </div>
                ),
              )}
            </div>
          ))
        )}
      </nav>

      <div className="sidebar-footer">
        <a href="#/models">Model Library</a>
        <a href="#/stats">Stats</a>
        <a href="#/settings">Settings</a>
      </div>
    </aside>
  );
}
