import { describe, it, expect } from 'vitest';
import { closesOverlay } from './escape';

describe('closesOverlay', () => {
  it('closes on a plain Escape', () => {
    expect(closesOverlay({ key: 'Escape', isComposing: false, defaultPrevented: false, targetTag: 'DIV', nestedModalOpen: false })).toBe(true);
  });

  it('ignores other keys and handled events', () => {
    expect(closesOverlay({ key: 'Enter', isComposing: false, defaultPrevented: false, targetTag: 'DIV', nestedModalOpen: false })).toBe(false);
    expect(closesOverlay({ key: 'Escape', isComposing: false, defaultPrevented: true, targetTag: 'DIV', nestedModalOpen: false })).toBe(false);
  });

  it('never discards typing: IME composition or a focused text field', () => {
    expect(closesOverlay({ key: 'Escape', isComposing: true, defaultPrevented: false, targetTag: 'DIV', nestedModalOpen: false })).toBe(false);
    expect(closesOverlay({ key: 'Escape', isComposing: false, defaultPrevented: false, targetTag: 'TEXTAREA', nestedModalOpen: false })).toBe(false);
    expect(closesOverlay({ key: 'Escape', isComposing: false, defaultPrevented: false, targetTag: 'INPUT', nestedModalOpen: false })).toBe(false);
  });

  it('leaves Escape to a dialog open on top', () => {
    expect(closesOverlay({ key: 'Escape', isComposing: false, defaultPrevented: false, targetTag: 'BUTTON', nestedModalOpen: true })).toBe(false);
  });
});
