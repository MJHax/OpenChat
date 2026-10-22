import { describe, expect, it } from 'vitest';
import { defaultContextWindow, hostOf, isLocalModelId, localModelId, localServerGroups, normalizeBaseUrl, parseLocalModelId, sharesServer } from './localModels';

describe('local model helpers', () => {
  it('round-trips names with colons and slashes', () => {
    for (const name of ['qwen3:1.7b', 'lmstudio-community/Qwen3-8B-GGUF', 'a:b/c:d']) {
      expect(parseLocalModelId(localModelId('ab12cd34', name))).toEqual({ serverId: 'ab12cd34', name });
    }
  });
  it('never reads an OpenRouter id as local', () => {
    for (const id of ['openai/gpt-4o', 'meta-llama/llama-3.3-70b-instruct:free', 'local', 'local:', 'local:abc']) {
      expect(parseLocalModelId(id)).toBeNull();
      expect(isLocalModelId(id)).toBe(false);
    }
  });
  it('defaults the window to the smaller of the max and 16,384', () => {
    expect(defaultContextWindow(40_960)).toBe(16_384);
    expect(defaultContextWindow(8_192)).toBe(8_192);
    expect(defaultContextWindow(null)).toBe(16_384);
  });
  it('normalizes loosely typed addresses', () => {
    for (const input of ['localhost:11434', 'http://localhost:11434/', 'http://localhost:11434/v1', ' HTTP://localhost:11434/v1/ ']) {
      expect(normalizeBaseUrl(input)).toBe('http://localhost:11434');
    }
    expect(normalizeBaseUrl('https://gpu.lan:8443/')).toBe('https://gpu.lan:8443');
    expect(() => normalizeBaseUrl('ftp://x')).toThrow('Enter an address like http://localhost:11434.');
    expect(() => normalizeBaseUrl('')).toThrow();
    for (const withLogin of ['http://user:pass@host:1234', 'user@localhost:11434', 'https://me@10.0.0.2']) {
      expect(() => normalizeBaseUrl(withLogin)).toThrow('Enter an address without a username or password.');
    }
    expect(hostOf('http://192.168.1.50:11434')).toBe('192.168.1.50:11434');
    expect(hostOf('http://me:pw@searx.lan:8080/x')).toBe('searx.lan:8080');
  });
});

describe('servers shared by local models', () => {
  it('groups distinct local ids by server in first-appearance order', () => {
    const ids = ['local:a:x', 'or/m', 'local:b:y', 'local:a:z', 'local:a:x'];
    expect(localServerGroups(ids)).toEqual([['local:a:x', 'local:a:z'], ['local:b:y']]);
    expect(sharesServer(ids)).toBe(true);
  });
  it('does not count different servers, the same model twice or OpenRouter models', () => {
    expect(sharesServer(['local:a:x', 'local:b:y', 'or/m'])).toBe(false);
    expect(sharesServer(['local:a:x', 'local:a:x'])).toBe(false);
  });
});
