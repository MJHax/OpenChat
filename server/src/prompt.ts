import type { Message } from '../../shared/types';

export interface Persona {
  aboutMe: string;
  customInstructions: string;
  memories: string[];
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function buildSystemPrompt(p: Persona): string | null {
  const sections: string[] = [];
  if (p.aboutMe.trim()) sections.push(`About the user:\n${p.aboutMe.trim()}`);
  if (p.customInstructions.trim()) sections.push(`Instructions:\n${p.customInstructions.trim()}`);
  const memories = p.memories.map((m) => m.trim()).filter(Boolean);
  if (memories.length) sections.push(`Things to remember about the user:\n${memories.map((m) => `- ${m}`).join('\n')}`);
  return sections.length ? sections.join('\n\n') : null;
}

export function buildMessages(p: Persona, path: Pick<Message, 'role' | 'content'>[]): ChatMessage[] {
  const system = buildSystemPrompt(p);
  const messages: ChatMessage[] = path.map((m) => ({ role: m.role, content: m.content }));
  return system ? [{ role: 'system', content: system }, ...messages] : messages;
}
