import { describe, it, expect } from 'vitest';
import { activePath, childrenOf, newestLeafFrom, withSiblings } from '../src/tree';
import type { Message } from '../../shared/types';

let t = 0;
const msg = (id: string, parentId: string | null, role: Message['role'] = 'user'): Message => ({
  id, chatId: 'c', parentId, role, content: id, modelId: null,
  promptTokens: null, completionTokens: null, cost: null, status: 'complete', createdAt: ++t, attachments: [], webSearch: false, sources: [], webSearches: null, participantId: null, handoffTo: null,
});

// u1 ─┬─ a1 ── u2 ── a3
//     └─ a2 ─┬─ u3
//            └─ u4 (newest)
const tree = [
  msg('u1', null), msg('a1', 'u1', 'assistant'), msg('u2', 'a1'), msg('a3', 'u2', 'assistant'),
  msg('a2', 'u1', 'assistant'), msg('u3', 'a2'), msg('u4', 'a2'),
];
const ids = (ms: Message[]) => ms.map((m) => m.id);

describe('activePath', () => {
  it('walks from the leaf to the root', () => {
    expect(ids(activePath(tree, 'a3'))).toEqual(['u1', 'a1', 'u2', 'a3']);
    expect(ids(activePath(tree, 'u3'))).toEqual(['u1', 'a2', 'u3']);
  });
  it('returns [] for a null or unknown leaf', () => {
    expect(activePath(tree, null)).toEqual([]);
    expect(activePath(tree, 'nope')).toEqual([]);
  });
});

describe('childrenOf', () => {
  it('returns children oldest first', () => {
    expect(ids(childrenOf(tree, 'u1'))).toEqual(['a1', 'a2']);
    expect(ids(childrenOf(tree, null))).toEqual(['u1']);
  });
});

describe('newestLeafFrom', () => {
  it('follows the newest child at each level', () => {
    expect(newestLeafFrom(tree, 'u1')).toBe('u4');
    expect(newestLeafFrom(tree, 'a1')).toBe('a3');
  });
  it('returns the message itself when it is a leaf', () => {
    expect(newestLeafFrom(tree, 'u3')).toBe('u3');
  });
});

describe('withSiblings', () => {
  it('annotates each path message with its sibling versions', () => {
    const path = withSiblings(tree, activePath(tree, 'u3'));
    expect(path.map((m) => [m.id, m.siblingIndex, m.siblingIds])).toEqual([
      ['u1', 0, ['u1']],
      ['a2', 1, ['a1', 'a2']],
      ['u3', 0, ['u3', 'u4']],
    ]);
  });
});
