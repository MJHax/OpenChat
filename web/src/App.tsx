import { useCallback, useEffect, useState } from 'react';
import type { ChatSummary, LibraryModel, SettingsView, ThreadKind } from '../../shared/types';
import { api } from './api';
import { navigate, useRoute } from './lib/route';
import { Sidebar, threadHref } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { ImageThread } from './pages/ImageThread';
import { ModelLibrary } from './pages/ModelLibrary';
import { Settings } from './pages/Settings';
import { Stats } from './pages/Stats';

export function App() {
  const route = useRoute();
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [models, setModels] = useState<LibraryModel[]>([]);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [chatReload, setChatReload] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The sidebar keeps showing the last mode while on Model Library, Stats or Settings.
  const [lastMode, setLastMode] = useState<ThreadKind>('chat');
  const mode: ThreadKind = route.page === 'images' ? 'image' : route.page === 'chat' ? 'chat' : lastMode;
  useEffect(() => setLastMode(mode), [mode]);

  const fail = (e: Error) => setLoadError(e.message);
  const refreshChats = useCallback(() => { api.listChats(mode).then(setChats).catch(fail); }, [mode]);
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

  useEffect(() => {
    document.documentElement.dataset.theme = settings?.theme ?? 'system';
  }, [settings?.theme]);

  const openChat = useCallback((chatId: string, kind: ThreadKind) => {
    navigate(threadHref(kind, chatId));
    setChatReload((n) => n + 1);
  }, []);

  const activeChatId = route.page === 'chat' ? route.chatId : route.page === 'images' ? route.threadId : null;
  const title = chats.find((c) => c.id === activeChatId)?.title ?? (route.page === 'images' ? 'New image' : 'New chat');

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
        {route.page === 'models' && <ModelLibrary models={models} onChanged={refreshModels} />}
        {route.page === 'stats' && <Stats />}
        {route.page === 'settings' && <Settings models={models} onChanged={refreshSettings} />}
      </main>
    </div>
  );
}
