import { describe, it, expect } from 'vitest';
import type { LibraryModel, LocalAvailability } from '../../../shared/types';
import { availabilityLabel, compareItemDisabled, unavailableReason } from './availability';

const model = (id: string, displayName: string, serverName: string | null = 'Ollama') => ({
  id, displayName, source: 'local', serverId: 's1', serverName,
}) as LibraryModel;
const models = [model('local:s1:qwen3:1.7b', 'qwen3:1.7b'), model('local:s1:gemma3:1b', 'gemma3:1b')];
const [a, b] = models.map((m) => m.id);

describe('availabilityLabel', () => {
  it('names each unavailable state', () => {
    expect(availabilityLabel('offline')).toBe('Offline');
    expect(availabilityLabel('missing')).toBe('Not installed');
    expect(availabilityLabel('off')).toBe('Turned off');
  });
  it('is null for ready and unknown', () => {
    expect(availabilityLabel('ready')).toBeNull();
    expect(availabilityLabel(undefined)).toBeNull();
  });
});

describe('unavailableReason', () => {
  const av = (r: Record<string, LocalAvailability>) => r;
  it('says an offline model is offline', () => {
    expect(unavailableReason(models, [a], av({ [a]: 'offline' }))).toBe('qwen3:1.7b is offline.');
  });
  it('names the server for a missing model', () => {
    expect(unavailableReason(models, [a], av({ [a]: 'missing' }))).toBe("qwen3:1.7b isn't installed on Ollama any more.");
  });
  it('says a turned-off server is turned off in Settings', () => {
    expect(unavailableReason(models, [a], av({ [a]: 'off' }))).toBe('Ollama is turned off in Settings.');
  });
  it('finds the unavailable model in a Compare', () => {
    expect(unavailableReason(models, [a, b], av({ [a]: 'ready', [b]: 'missing' }))).toBe("gemma3:1b isn't installed on Ollama any more.");
  });
  it('is null when all are ready or unknown', () => {
    expect(unavailableReason(models, [a, b], av({ [a]: 'ready' }))).toBeNull();
    expect(unavailableReason(models, [], {})).toBeNull();
  });
});

describe('compareItemDisabled', () => {
  it('keeps a ticked model clickable even when it went offline', () => {
    expect(compareItemDisabled(true, 2, 4, 'offline')).toBe(false);
  });
  it('disables an unticked unavailable model', () => {
    expect(compareItemDisabled(false, 2, 4, 'missing')).toBe(true);
  });
  it('disables an unticked model once the limit is reached, but not a ticked one', () => {
    expect(compareItemDisabled(false, 4, 4, 'ready')).toBe(true);
    expect(compareItemDisabled(true, 4, 4, 'ready')).toBe(false);
  });
});
