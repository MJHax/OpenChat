import type { DB } from './db';
import { HttpError } from './http';
import type { Persona } from './prompt';
import type { SettingsUpdate, SettingsView, Theme } from '../../shared/types';

const DEFAULTS = {
  api_key: '',
  about_me: '',
  custom_instructions: '',
  theme: 'system',
  default_model_id: '',
  title_model_id: '',
  memory_model_id: '',
};
export type SettingKey = keyof typeof DEFAULTS;
export type Env = Record<string, string | undefined>;

const THEMES: Theme[] = ['light', 'dark', 'system'];

const UPDATE_KEYS: Record<keyof SettingsUpdate, SettingKey> = {
  apiKey: 'api_key',
  aboutMe: 'about_me',
  customInstructions: 'custom_instructions',
  theme: 'theme',
  defaultModelId: 'default_model_id',
  titleModelId: 'title_model_id',
  memoryModelId: 'memory_model_id',
};

export function getSetting(db: DB, key: SettingKey): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? DEFAULTS[key];
}

export function setSetting(db: DB, key: SettingKey, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function resolveApiKey(db: DB, env: Env): { key: string; source: 'settings' | 'env' | 'none' } {
  const stored = getSetting(db, 'api_key');
  if (stored) return { key: stored, source: 'settings' };
  const fromEnv = env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  return { key: '', source: 'none' };
}

export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 10) return '••••';
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export function getSettingsView(db: DB, env: Env): SettingsView {
  const { key, source } = resolveApiKey(db, env);
  return {
    hasApiKey: Boolean(key),
    apiKeySource: source,
    apiKeyMasked: maskKey(key),
    aboutMe: getSetting(db, 'about_me'),
    customInstructions: getSetting(db, 'custom_instructions'),
    theme: getSetting(db, 'theme') as Theme,
    defaultModelId: getSetting(db, 'default_model_id'),
    titleModelId: getSetting(db, 'title_model_id'),
    memoryModelId: getSetting(db, 'memory_model_id'),
  };
}

export function updateSettings(db: DB, update: SettingsUpdate): void {
  if (update.theme !== undefined && !THEMES.includes(update.theme)) {
    throw new HttpError(400, 'Theme must be light, dark, or system.');
  }
  for (const [field, key] of Object.entries(UPDATE_KEYS) as [keyof SettingsUpdate, SettingKey][]) {
    const value = update[field];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string.`);
    setSetting(db, key, field === 'apiKey' ? value.trim() : value);
  }
}

export function getPersona(db: DB): Persona {
  const rows = db.prepare('SELECT content FROM memories WHERE enabled = 1 ORDER BY created_at, id').all() as { content: string }[];
  return {
    aboutMe: getSetting(db, 'about_me'),
    customInstructions: getSetting(db, 'custom_instructions'),
    memories: rows.map((r) => r.content),
  };
}

/** The persona for a reply in `chatId`: the global one plus that chat's instructions, or `draft` for a chat not made yet. */
export function chatPersona(db: DB, chatId: string | null, draft = ''): Persona {
  const row = chatId ? (db.prepare('SELECT instructions FROM chats WHERE id = ?').get(chatId) as { instructions: string } | undefined) : undefined;
  return { ...getPersona(db), chatInstructions: chatId ? row?.instructions ?? '' : draft };
}
