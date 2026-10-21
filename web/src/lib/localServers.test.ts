import { describe, expect, it } from 'vitest';
import type { LocalServerStatus } from '../../../shared/types';
import { defaultAddress, defaultName, statusLabel } from './localServers';

const base: LocalServerStatus = {
  id: 's1', type: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434',
  auto: true, enabled: true, online: true, modelCount: 2, error: null,
};

describe('statusLabel', () => {
  it('counts models when online', () => {
    expect(statusLabel(base)).toBe('Online · 2 models');
    expect(statusLabel({ ...base, modelCount: 1 })).toBe('Online · 1 model');
  });
  it('says Offline when unreachable', () => {
    expect(statusLabel({ ...base, online: false, modelCount: null, error: 'x' })).toBe('Offline');
  });
  it('says Turned off when disabled', () => {
    expect(statusLabel({ ...base, enabled: false, online: false })).toBe('Turned off');
  });
});

describe('defaults', () => {
  it('names by type', () => {
    expect(defaultName('ollama')).toBe('Ollama');
    expect(defaultName('lmstudio')).toBe('LM Studio');
    expect(defaultName('openai')).toBe('OpenAI-compatible server');
  });
  it('addresses by type', () => {
    expect(defaultAddress('ollama')).toBe('http://localhost:11434');
    expect(defaultAddress('lmstudio')).toBe('http://localhost:1234');
    expect(defaultAddress('openai')).toBe('');
  });
});
