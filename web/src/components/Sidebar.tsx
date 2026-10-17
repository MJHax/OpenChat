import { useEffect, useState } from 'react';
import type { ChatSummary, SearchHit } from '../../../shared/types';
import { api } from '../api';
import { groupByDate, splitSnippet } from '../lib/format';
import { navigate } from '../lib/route';

export interface SidebarProps {
  chats: ChatSummary[];
  activeChatId: string | null;
  onChatsChanged(): void;
  onOpenChat(chatId: string): void;
}

export function Sidebar({ chats, activeChatId, onChatsChanged, onOpenChat }: SidebarProps) {
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
    onOpenChat(hit.chatId);
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
    await api.deleteChat(chat.id).catch(() => {});
    if (chat.id === activeChatId) navigate('#/');
    onChatsChanged();
  }

  if (collapsed) {
    return (
      <aside className="sidebar collapsed">
        <button className="icon" onClick={() => setCollapsed(false)} aria-label="Expand sidebar" title="Expand sidebar">☰</button>
        <button className="icon" onClick={() => navigate('#/')} aria-label="New chat" title="New chat">＋</button>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <span className="brand">OpenChat</span>
        <button className="icon" onClick={() => setCollapsed(true)} aria-label="Collapse sidebar" title="Collapse sidebar">⟨</button>
      </div>
      <button className="new-chat" onClick={() => navigate('#/')}>＋ New chat</button>
      <input className="search" type="search" placeholder="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} />

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
                    <a href={`#/chat/${chat.id}`} title={chat.title}>{chat.title}</a>
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
