import { useCallback, useEffect, useState } from 'react';
import type { ChatSummary, LibraryModel, SettingsView } from '../../shared/types';
import { api } from './api';
import { navigate, useRoute } from './lib/route';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { ModelLibrary } from './pages/ModelLibrary';
import { Settings } from './pages/Settings';

export function App() {
  const route = useRoute();
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [models, setModels] = useState<LibraryModel[]>([]);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [chatReload, setChatReload] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fail = (e: Error) => setLoadError(e.message);
  const refreshChats = useCallback(() => { api.listChats().then(setChats).catch(fail); }, []);
  const refreshModels = useCallback(() => {
    api.listModels().then(setModels).catch(fail);
    api.getSettings().then(setSettings).catch(fail); // default model lives in settings
  }, []);
  const refreshSettings = useCallback(() => { api.getSettings().then(setSettings).catch(fail); }, []);

  useEffect(() => {
    refreshChats();
    refreshModels();
  }, [refreshChats, refreshModels]);

  useEffect(() => {
    document.documentElement.dataset.theme = settings?.theme ?? 'system';
  }, [settings?.theme]);

  const openChat = useCallback((chatId: string) => {
    navigate(`#/chat/${chatId}`);
    setChatReload((n) => n + 1);
  }, []);

  const activeChatId = route.page === 'chat' ? route.chatId : null;
  const title = chats.find((c) => c.id === activeChatId)?.title ?? 'New chat';

  return (
    <div className="app">
      <Sidebar chats={chats} activeChatId={activeChatId} onChatsChanged={refreshChats} onOpenChat={openChat} />
      <main className="main">
        {loadError && <div className="banner error">Can't reach the OpenChat server: {loadError}</div>}
        {route.page === 'chat' && (
          <ChatView chatId={route.chatId} title={title} reloadToken={chatReload} models={models} settings={settings} onChatsChanged={refreshChats} />
        )}
        {route.page === 'models' && <ModelLibrary models={models} onChanged={refreshModels} />}
        {route.page === 'settings' && <Settings models={models} onChanged={refreshSettings} />}
      </main>
    </div>
  );
}
