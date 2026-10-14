import type { Message, PathMessage } from '../../shared/types';

// All functions expect `messages` ordered oldest first (as returned by getChatMessages).

export function activePath(messages: Message[], leafId: string | null): Message[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const path: Message[] = [];
  let cur = leafId ? byId.get(leafId) : undefined;
  while (cur) {
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path.reverse();
}

export function childrenOf(messages: Message[], parentId: string | null): Message[] {
  return messages.filter((m) => m.parentId === parentId);
}

export function newestLeafFrom(messages: Message[], messageId: string): string {
  let id = messageId;
  for (;;) {
    const kids = childrenOf(messages, id);
    if (kids.length === 0) return id;
    id = kids[kids.length - 1].id;
  }
}

export function withSiblings(messages: Message[], path: Message[]): PathMessage[] {
  return path.map((m) => {
    const siblingIds = childrenOf(messages, m.parentId).map((s) => s.id);
    return { ...m, siblingIds, siblingIndex: siblingIds.indexOf(m.id) };
  });
}

/** Assistant replies to a user message, oldest first. */
export function repliesTo(messages: Message[], parentId: string): Message[] {
  return childrenOf(messages, parentId).filter((m) => m.role === 'assistant');
}
