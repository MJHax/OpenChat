import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Accent, ChatSummary, ColorStyle, LibraryModel, SettingsView, ThreadKind } from '../../shared/types';
import { api } from './api';
import { navigate, replaceHash, routeHash, settingsBackdrop, settingsCloseAction, threadHref, useRoute, type Route } from './lib/route';
import { IconRail, type RailItem } from './components/shell/IconRail';
import { ThreadPanel } from './components/shell/ThreadPanel';
import { CommandPalette } from './components/shell/CommandPalette';
import { nextTheme, resolvedTheme } from './lib/appearance';
import { ChatView } from './components/ChatView';
import { ImageThread } from './pages/ImageThread';
import { VideoThread } from './pages/VideoThread';
import { DiscussionPage } from './pages/DiscussionPage';
import { systemNotify } from './lib/notify';
import { loadLibrarySort, saveLibrarySort, sortLibrary, type LibrarySort } from './lib/models';
import { ModelLibrary } from './pages/ModelLibrary';
import { Settings } from './pages/Settings';
import { Stats } from './pages/Stats';
import { Library } from './pages/Library';
import { PromptsWindow } from './components/PromptsWindow';
import type { ReuseDraft } from './lib/reuse';
import { useAppearance } from './components/useAppearance';
import { Clapperboard, X } from 'lucide-react';

const NARROW = '(max-width: 899px)';

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const update = () => setNarrow(mq.matches);
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return narrow;
}

export function App() {
  const route = useRoute();
  // Settings opens over the page it came from; `page` is that page (or the route itself).
  // Adjusted while rendering (not in an effect), so the first frame with Settings open already has its backdrop.
  const [lastPage, setLastPage] = useState<Route | null>(null);
  if (route.page !== 'settings' && route !== lastPage) setLastPage(route);
  const page = route.page === 'settings' ? settingsBackdrop(lastPage) : route;
  const closeSettings = useCallback(() => {
    if (settingsCloseAction(lastPage) === 'back') window.history.back();
    else replaceHash(routeHash(settingsBackdrop(lastPage)));
  }, [lastPage]);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [libraryModels, setModels] = useState<LibraryModel[]>([]);
  // Every model picker follows the order chosen in the Model Library.
  const [librarySort, setLibrarySort] = useState<LibrarySort>(loadLibrarySort);
  const models = useMemo(() => sortLibrary(libraryModels, librarySort), [libraryModels, librarySort]);
  const changeLibrarySort = (sort: LibrarySort) => { setLibrarySort(sort); saveLibrarySort(sort); };
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [chatReload, setChatReload] = useState(0);
  /** Files the Library is starting a new chat with; ChatView takes them and clears this. */
  const [startDraft, setStartDraft] = useState<(ReuseDraft & { nonce: number }) | null>(null);
  const startChatWith = (d: ReuseDraft) => {
    setStartDraft((s) => ({ ...d, nonce: (s?.nonce ?? 0) + 1 }));
    navigate('#/');
  };
  /** A saved prompt on its way into the chat's message box; ChatView takes it and clears this. */
  const [insertReq, setInsertReq] = useState<{ text: string; nonce: number } | null>(null);
  const insertNonce = useRef(0);
  const insertPrompt = (text: string) => setInsertReq({ text, nonce: ++insertNonce.current });
  const [promptsOpen, setPromptsOpen] = useState(false);
  const openPrompts = useCallback(() => setPromptsOpen(true), []);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The sidebar keeps showing the last mode while on Model Library, Stats or Settings.
  const [lastMode, setLastMode] = useState<ThreadKind>('chat');
  const mode: ThreadKind = page.page === 'images' ? 'image' : page.page === 'video' ? 'video' : page.page === 'chat' ? 'chat'
    : page.page === 'discussions' ? 'discussion' : lastMode;
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
  // A settings fetch that started before a save finished may carry the old values; its result is dropped.
  const settingsEpoch = useRef(0);
  const refreshSettings = useCallback(() => {
    const epoch = settingsEpoch.current;
    api.getSettings().then((s) => { if (epoch === settingsEpoch.current) setSettings(s); }).catch(fail);
  }, []);
  const settingsSaved = useCallback((view: SettingsView) => { settingsEpoch.current++; setSettings(view); }, []);
  const refreshModels = useCallback(() => {
    api.listModels().then(setModels).catch(fail);
    refreshSettings(); // default model lives in settings
  }, [refreshSettings]);

  useEffect(() => refreshChats(), [refreshChats]);
  useEffect(() => refreshModels(), [refreshModels]);

  // While an image is being made somewhere, keep the list fresh so its spinner and thumbnail update.
  const anyBusy = chats.some((c) => c.busy);
  useEffect(() => {
    if (!anyBusy) return;
    const timer = setInterval(refreshChats, 3000);
    return () => clearInterval(timer);
  }, [anyBusy, refreshChats]);

  const { appearance, setAppearance, systemDark } = useAppearance(settings, settingsSaved);

  const openChat = useCallback((chatId: string, kind: ThreadKind) => {
    navigate(threadHref(kind, chatId));
    setChatReload((n) => n + 1);
  }, []);

  const activeChatId = page.page === 'chat' ? page.chatId : page.page === 'images' || page.page === 'video' ? page.threadId
    : page.page === 'discussions' ? page.discussionId : null;
  const title = chats.find((c) => c.id === activeChatId)?.title ?? (page.page === 'images' ? 'New image' : page.page === 'video' ? 'New video' : 'New chat');

  // The thread panel: collapsed by the user, or starting collapsed (as an overlay) in a narrow window.
  const narrow = useNarrow();
  const [panelOpen, setPanelOpen] = useState(() => !window.matchMedia(NARROW).matches);
  useEffect(() => setPanelOpen(!narrow), [narrow]);
  const togglePanel = useCallback(() => setPanelOpen((o) => !o), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'b' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        togglePanel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePanel]);
  // In a narrow window the panel floats over the page, so following a link closes it.
  useEffect(() => { if (narrow) setPanelOpen(false); }, [narrow, route]);

  // Command palette: Ctrl/Cmd+K anywhere.
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const runCommand = (id: string) => {
    const go: Record<string, string> = {
      'new-chat': '#/', 'new-image': '#/images', 'new-video': '#/video', 'new-discussion': '#/discussions', 'go-models': '#/models', 'go-stats': '#/stats', 'go-library': '#/library',
    };
    if (go[id]) return navigate(go[id]);
    if (id === 'open-prompts') return setPromptsOpen(true);
    if (id.startsWith('go-settings-')) {
      const hash = `#/settings/${id.slice('go-settings-'.length)}`;
      return route.page === 'settings' ? replaceHash(hash) : navigate(hash); // one history entry for Settings, however many tabs
    }
    if (id === 'toggle-theme') return void setAppearance({ theme: nextTheme(appearance.theme, systemDark) });
    if (id.startsWith('accent-')) return void setAppearance({ accent: id.slice('accent-'.length) as Accent });
    if (id.startsWith('style-')) return void setAppearance({ colorStyle: id.slice('style-'.length) as ColorStyle });
  };

  const overlayOpen = route.page === 'settings' || paletteOpen || promptsOpen;
  // Remember the last thing focused outside an overlay, and put focus back there when the overlay closes.
  // (Making the background inert blurs it before the overlay mounts, so the overlay can't record it itself.)
  const lastFocus = useRef<HTMLElement | null>(null);
  const overlayRef = useRef(overlayOpen);
  overlayRef.current = overlayOpen;
  useEffect(() => {
    const onFocus = (e: FocusEvent) => { if (!overlayRef.current && e.target instanceof HTMLElement) lastFocus.current = e.target; };
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  }, []);
  const wasOpen = useRef(overlayOpen);
  useEffect(() => {
    if (wasOpen.current && !overlayOpen) requestAnimationFrame(() => { if (lastFocus.current?.isConnected) lastFocus.current.focus(); });
    wasOpen.current = overlayOpen;
  }, [overlayOpen]);
  const railActive: RailItem = promptsOpen ? 'prompts' : route.page === 'settings' ? 'settings' : page.page === 'models' ? 'models' : page.page === 'stats' ? 'stats'
    : page.page === 'library' ? 'library' : mode;
  const shownTheme = resolvedTheme(appearance.theme, systemDark);

  return (
    <div className={`app${panelOpen ? '' : ' panel-closed'}${narrow ? ' narrow' : ''}`}>
      {/* While Settings or the palette is open, everything behind it is inert, so focus and screen readers stay in the dialog. */}
      <div className="rail-slot" inert={overlayOpen}>
      <IconRail active={railActive} mode={mode} resolvedTheme={shownTheme} onTogglePanel={togglePanel} settingsHref="#/settings" onOpenPrompts={openPrompts}
        onToggleTheme={() => void setAppearance({ theme: nextTheme(appearance.theme, systemDark) })} />
      </div>
      <div className="threads-slot" aria-hidden={!panelOpen} inert={!panelOpen || overlayOpen}>
        <ThreadPanel mode={mode} chats={chats} activeChatId={activeChatId} onChatsChanged={refreshChats} onOpenChat={openChat}
          onCollapse={() => setPanelOpen(false)} onOpenPalette={() => setPaletteOpen(true)} />
      </div>
      {narrow && panelOpen && <div className="threads-scrim" onClick={() => setPanelOpen(false)} />}
      <main className="main">
        <div className="aurora" aria-hidden />
        <div className="page-slot" inert={overlayOpen}>
        {loadError && <div className="banner error">Can't reach the OpenChat server: {loadError}</div>}
        {page.page === 'chat' && (
          <ChatView chatId={page.chatId} title={title} reloadToken={chatReload} models={models} settings={settings} onChatsChanged={refreshChats}
            startDraft={page.chatId ? null : startDraft} onStartDraftUsed={() => setStartDraft(null)}
            insert={insertReq} onInsertUsed={() => setInsertReq(null)} onOpenPrompts={openPrompts} />
        )}
        {page.page === 'images' && (
          <ImageThread threadId={page.threadId} title={title} reloadToken={chatReload} settings={settings} onThreadsChanged={refreshChats} />
        )}
        {page.page === 'video' && (
          <VideoThread threadId={page.threadId} title={title} reloadToken={chatReload} settings={settings} onThreadsChanged={refreshChats} />
        )}
        {page.page === 'discussions' && (
          <DiscussionPage key={page.discussionId ?? 'new'} discussionId={page.discussionId} models={models} settings={settings}
            onDiscussionsChanged={refreshChats} />
        )}
        {page.page === 'models' && <ModelLibrary models={models} onChanged={refreshModels} sort={librarySort} onSort={changeLibrarySort} />}
        {page.page === 'stats' && <Stats />}
        {page.page === 'library' && <Library onReuse={startChatWith} />}
        </div>
        {route.page === 'settings' && (
          <Settings models={models} tab={route.tab} section={route.section} onChanged={refreshSettings} onClose={closeSettings}
            appearance={appearance} onAppearance={(patch) => void setAppearance(patch)}
            onDataChanged={() => { refreshChats(); refreshModels(); }} />
        )}
      </main>
      {promptsOpen && (
        <PromptsWindow canInsert={page.page === 'chat' && route.page !== 'settings'} onClose={() => setPromptsOpen(false)}
          onInsert={(text) => { setPromptsOpen(false); insertPrompt(text); }}
          onStartChat={(text) => { setPromptsOpen(false); startChatWith({ attachments: [], files: [], text }); }} />
      )}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} onCommand={runCommand} onOpenChat={openChat} />}
      {toasts.length > 0 && (
        <div className="toasts" role="status">
          {toasts.map((t) => (
            <div key={t.id} className="toast">
              <button className="link toast-open" onClick={() => { setToasts((x) => x.filter((y) => y.id !== t.id)); openChat(t.id, 'video'); }}>
                <Clapperboard size={16} className="toast-icon" /> “{t.title}” finished
              </button>
              <button className="icon" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}><X size={16} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
