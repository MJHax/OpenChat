/** Whether an Escape keypress should close an overlay (Settings): never mid-typing, and not when a dialog sits on top. */
export function closesOverlay(e: { key: string; isComposing: boolean; defaultPrevented: boolean; targetTag: string; nestedModalOpen: boolean }): boolean {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || e.nestedModalOpen) return false;
  // Escape in a text field would throw away an unsaved draft.
  return !['INPUT', 'TEXTAREA', 'SELECT'].includes(e.targetTag);
}
