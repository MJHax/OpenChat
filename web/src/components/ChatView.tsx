import type { LibraryModel, SettingsView } from '../../../shared/types';

export interface ChatViewProps {
  chatId: string | null;
  title: string;
  reloadToken: number;
  models: LibraryModel[];
  settings: SettingsView | null;
  onChatsChanged(): void;
}

export function ChatView(_props: ChatViewProps) {
  return <div className="chat">Chat</div>;
}
