export type LocalServerType = 'ollama' | 'lmstudio' | 'openai';

export const SERVER_TYPE_NAMES: Record<LocalServerType, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  openai: 'OpenAI-compatible server',
};

/** Addresses probed when looking for servers already running on this machine. */
export const DETECT_CANDIDATES: { type: 'ollama' | 'lmstudio'; baseUrl: string }[] = [
  { type: 'ollama', baseUrl: 'http://localhost:11434' },
  { type: 'lmstudio', baseUrl: 'http://localhost:1234' },
];

export const DEFAULT_LOCAL_WINDOW = 16_384;

const PREFIX = 'local:';

/** Local model ids are `local:<serverId>:<name>`; server ids never contain a colon, names may. */
export function localModelId(serverId: string, name: string): string {
  return `${PREFIX}${serverId}:${name}`;
}

export function parseLocalModelId(id: string): { serverId: string; name: string } | null {
  if (!id.startsWith(PREFIX)) return null;
  const rest = id.slice(PREFIX.length);
  const i = rest.indexOf(':');
  if (i <= 0 || i === rest.length - 1) return null;
  return { serverId: rest.slice(0, i), name: rest.slice(i + 1) };
}

export function isLocalModelId(id: string): boolean {
  return parseLocalModelId(id) !== null;
}

export function defaultContextWindow(max: number | null): number {
  return max === null ? DEFAULT_LOCAL_WINDOW : Math.min(max, DEFAULT_LOCAL_WINDOW);
}

export function normalizeBaseUrl(input: string): string {
  const bad = () => new Error('Enter an address like http://localhost:11434.');
  let s = input.trim();
  if (!s) throw bad();
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (m) {
    const scheme = m[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') throw bad();
    s = scheme + s.slice(m[1].length);
  } else {
    s = `http://${s}`;
  }
  s = s.replace(/\/+$/, '').replace(/\/v1$/i, '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+/.test(s)) throw bad();
  if (/^https?:\/\/[^/]*@/.test(s)) throw new Error('Enter an address without a username or password.');
  return s;
}

export function hostOf(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
}
