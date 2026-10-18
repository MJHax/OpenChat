// Per-chat settings the browser keeps (web/src/lib/compare.ts, web/src/lib/search.ts).
const PER_CHAT = ['openchat.compare.', 'openchat.search.'];

function keys(): string[] {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k !== null) out.push(k);
  }
  return out;
}

/** Forgets the browser's per-chat settings for these chats, once they are deleted. */
export function forgetChatPrefs(chatIds: string[]): void {
  try {
    for (const id of chatIds) for (const prefix of PER_CHAT) localStorage.removeItem(`${prefix}${id}`);
  } catch {
    // storage unavailable (private window); nothing was stored either
  }
}

/** Forgets everything OpenChat kept in this browser, for "Delete all my data". */
export function forgetAllPrefs(): void {
  try {
    for (const k of keys()) if (k.startsWith('openchat.')) localStorage.removeItem(k);
  } catch {
    // storage unavailable (private window); nothing was stored either
  }
}
