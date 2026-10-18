export interface CompareState {
  enabled: boolean;
  modelIds: string[];
}

export const COMPARE_OFF: CompareState = { enabled: false, modelIds: [] };
export const MAX_COMPARE = 4;

export const compareKey = (chatId: string) => `openchat.compare.${chatId}`;

export function parseCompareState(raw: string | null): CompareState {
  try {
    const value = JSON.parse(raw ?? '');
    const ids = Array.isArray(value?.modelIds) ? value.modelIds.filter((id: unknown): id is string => typeof id === 'string') : [];
    return { enabled: value?.enabled === true, modelIds: [...new Set<string>(ids)].slice(0, MAX_COMPARE) };
  } catch {
    return COMPARE_OFF;
  }
}

/** The models a comparison should use, or null if compare is off or fewer than 2 chosen models are still in the library. */
export function compareModels(state: CompareState, libraryIds: string[]): string[] | null {
  if (!state.enabled) return null;
  const ids = state.modelIds.filter((id) => libraryIds.includes(id));
  return ids.length >= 2 && ids.length <= MAX_COMPARE ? ids : null;
}

export function toggleModel(state: CompareState, id: string): CompareState {
  if (state.modelIds.includes(id)) return { ...state, modelIds: state.modelIds.filter((m) => m !== id) };
  if (state.modelIds.length >= MAX_COMPARE) return state;
  return { ...state, modelIds: [...state.modelIds, id] };
}

export function loadCompare(chatId: string): CompareState {
  try {
    return parseCompareState(localStorage.getItem(compareKey(chatId)));
  } catch {
    return COMPARE_OFF;
  }
}

export function saveCompare(chatId: string, state: CompareState): void {
  try {
    localStorage.setItem(compareKey(chatId), JSON.stringify(state));
  } catch {
    // storage unavailable (private window); compare mode just won't be remembered
  }
}
