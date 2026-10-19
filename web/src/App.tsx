import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatSummary, LibraryModel, SettingsView, ThreadKind } from '../../shared/types';
import { api } from './api';
import { navigate, useRoute } from './lib/route';
import { Sidebar, threadHref } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { ImageThread } from './pages/ImageThread';
import { VideoThread } from './pages/VideoThread';
import { DiscussionPage } from './pages/DiscussionPage';
import { systemNotify } from './lib/notify';
import { loadLibrarySort, saveLibrarySort, sortLibrary, type LibrarySort } from './lib/models';
import { ModelLibrary } from './pages/ModelLibrary';
import { Settings } from './pages/Settings';
import { Stats } from './pages/Stats';
import { useAppearance } from './components/useAppearance';

export function App() {
  const route = useRoute();
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [libraryModels, setModels] = useState<LibraryModel[]>([]);
  // Every model picker follows the order chosen in the Model Library.
  const [librarySort, setLibrarySort] = useState<LibrarySort>(loadLibrarySort);
  const models = useMemo(() => sortLibrary(libraryModels, librarySort), [libraryModels, librarySort]);
  const changeLibrarySort = (sort: LibrarySort) => { setLibrarySort(sort); saveLibrarySort(sort); };
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [chatReload, setChatReload] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The sidebar keeps showing the last mode while on Model Library, Stats or Settings.
  const [lastMode, setLastMode] = useState<ThreadKind>('chat');
  const mode: ThreadKind = route.page === 'images' ? 'image' : route.page === 'video' ? 'video' : route.page === 'chat' ? 'chat'
    : route.page === 'discussions' ? 'discussion' : lastMode;
  const [toasts, setToasts] = useState<{ id: string; title: string }[]>([]);

  // Clips render for minutes: watch video threads from anywhere in the app and say when one is ready.
  const rendering = useRef<Set<string> | null>(null);
  useEffect(() => {
    const check = () => api.listChats('video').then((list) => {
      const busy = new Set(list.filter((c) => c.busy).map((c) => c.id));
      for (const id of rendering.current ?? []) {
        if (busy.has(id)) continue;
        const thread = list.find((c) => c.id === id);
        if (!thread) continue; // deleted while rendering
        // No toast when that thread is already on screen; a hidden tab still gets the system notification.
        if (window.location.hash !== `#/video/${id}`) setToasts((t) => [...t, { id, title: thread.title }]);
        systemNotify(thread.title, id);
        refreshRef.current(); // the finished thread now has a title and no spinner
      }
      rendering.current = busy;
    }).catch(() => {});
    void check();
    const timer = setInterval(check, 15_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => setLastMode(mode), [mode]);

  const fail = (e: Error) => setLoadError(e.message);
  const refreshChats = useCallback(() => { api.listChats(mode).then(setChats).catch(fail); }, [mode]);
  const refreshRef = useRef(refreshChats);
  refreshRef.current = refreshChats;
  const refreshModels = useCallback(() => {
    api.listModels().then(setModels).catch(fail);
    api.getSettings().then(setSettings).catch(fail); // default model lives in settings
  }, []);
  const refreshSettings = useCallback(() => { api.getSettings().then(setSettings).catch(fail); }, []);

  useEffect(() => refreshChats(), [refreshChats]);
  useEffect(() => refreshModels(), [refreshModels]);

  // While an image is being made somewhere, keep the list fresh so its spinner and thumbnail update.
  const anyBusy = chats.some((c) => c.busy);
  useEffect(() => {
    if (!anyBusy) return;
    const timer = setInterval(refreshChats, 3000);
    return () => clearInterval(timer);
  }, [anyBusy, refreshChats]);

  const { appearance, setAppearance, systemDark } = useAppearance(settings);

  const openChat = useCallback((chatId: string, kind: ThreadKind) => {
    navigate(threadHref(kind, chatId));
    setChatReload((n) => n + 1);
  }, []);

  const activeChatId = route.page === 'chat' ? route.chatId : route.page === 'images' || route.page === 'video' ? route.threadId
    : route.page === 'discussions' ? route.discussionId : null;
  const title = chats.find((c) => c.id === activeChatId)?.title ?? (route.page === 'images' ? 'New image' : route.page === 'video' ? 'New video' : 'New chat');

  return (
    <div className="app">
      <Sidebar mode={mode} chats={chats} activeChatId={activeChatId} onChatsChanged={refreshChats} onOpenChat={openChat} />
      <main className="main">
        {loadError && <div className="banner error">Can't reach the OpenChat server: {loadError}</div>}
        {route.page === 'chat' && (
          <ChatView chatId={route.chatId} title={title} reloadToken={chatReload} models={models} settings={settings} onChatsChanged={refreshChats} />
        )}
        {route.page === 'images' && (
          <ImageThread threadId={route.threadId} title={title} reloadToken={chatReload} settings={settings} onThreadsChanged={refreshChats} />
        )}
        {route.page === 'video' && (
          <VideoThread threadId={route.threadId} title={title} reloadToken={chatReload} settings={settings} onThreadsChanged={refreshChats} />
        )}
        {route.page === 'discussions' && (
          <DiscussionPage key={route.discussionId ?? 'new'} discussionId={route.discussionId} models={models} settings={settings}
            onDiscussionsChanged={refreshChats} />
        )}
        {route.page === 'models' && <ModelLibrary models={models} onChanged={refreshModels} sort={librarySort} onSort={changeLibrarySort} />}
        {route.page === 'stats' && <Stats />}
        {route.page === 'settings' && (
          <Settings models={models} tab={route.tab} section={route.section} onChanged={refreshSettings}
            onDataChanged={() => { refreshChats(); refreshModels(); }} />
        )}
      </main>
      {toasts.length > 0 && (
        <div className="toasts" role="status">
          {toasts.map((t) => (
            <div key={t.id} className="toast">
              <button className="link" onClick={() => { setToasts((x) => x.filter((y) => y.id !== t.id)); openChat(t.id, 'video'); }}>
                🎬 “{t.title}” finished
              </button>
              <button className="icon" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
