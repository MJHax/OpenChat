import type { ChatSummary } from '../../../shared/types';

export interface SidebarProps {
  chats: ChatSummary[];
  activeChatId: string | null;
  onChatsChanged(): void;
  onOpenChat(chatId: string): void;
}

export function Sidebar(_props: SidebarProps) {
  return <aside className="sidebar">Sidebar</aside>;
}
