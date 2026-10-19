import { compareKey } from './compare';
import { searchKey } from './search';
import { effortKey } from './effort';

/** Removes the per-chat settings this browser keeps (compare mode, web search, effort) for chats that were deleted. */
export function forgetChatPrefs(chatIds: string[]): void {
  try {
    for (const id of chatIds) {
      localStorage.removeItem(compareKey(id));
      localStorage.removeItem(searchKey(id));
      localStorage.removeItem(effortKey(id));
    }
  } catch {
    // storage unavailable (private window); nothing was saved there
  }
}
