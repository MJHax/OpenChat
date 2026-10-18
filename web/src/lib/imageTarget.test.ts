import { describe, it, expect } from 'vitest';
import { editTarget, pickImageModel } from './imageTarget';
import type { MediaLibraryModel } from '../../../shared/types';
import type { ImageModel } from '../../../shared/imageModels';

const onPath = ['img1', 'img2', 'img3'];

describe('editTarget', () => {
  it('edits the latest image by default', () => {
    expect(editTarget({ picked: null, newImage: false, uploads: 0, onPath })).toEqual({ id: 'img3', note: 'Editing the image above' });
  });

  it('edits a picked earlier image', () => {
    expect(editTarget({ picked: 'img1', newImage: false, uploads: 0, onPath })).toEqual({ id: 'img1', note: 'Editing image 1' });
  });

  it('keeps a picked image that is on another branch', () => {
    expect(editTarget({ picked: 'other', newImage: false, uploads: 0, onPath })).toEqual({ id: 'other', note: 'Editing an image from another version' });
  });

  it('lets an attached photo replace the latest image as the target', () => {
    expect(editTarget({ picked: null, newImage: false, uploads: 1, onPath })).toEqual({ id: null, note: 'Editing your photo' });
    expect(editTarget({ picked: null, newImage: false, uploads: 2, onPath })).toEqual({ id: null, note: 'Editing your photos' });
  });

  it('still edits a picked image together with attached photos', () => {
    expect(editTarget({ picked: 'img2', newImage: false, uploads: 1, onPath })).toEqual({ id: 'img2', note: 'Editing image 2' });
  });

  it('makes a new image when asked, or when there is nothing to edit', () => {
    expect(editTarget({ picked: 'img2', newImage: true, uploads: 0, onPath })).toEqual({ id: null, note: null });
    expect(editTarget({ picked: null, newImage: false, uploads: 0, onPath: [] })).toEqual({ id: null, note: null });
  });
});

describe('pickImageModel', () => {
  const m = (id: string): ImageModel => ({
    id, name: id, description: '', created: null, aspects: [], resolutions: [], qualities: [], transparent: false, maxRefs: 0, minRefs: 0, price: { kind: 'unknown' },
  });
  const entry = (id: string, model: ImageModel | null): MediaLibraryModel => ({ id, displayName: id, kind: 'image', model, avgCost: {} });

  it('uses the saved model when the catalog still has it', () => {
    expect(pickImageModel([entry('a', m('a')), entry('b', m('b'))], 'b')?.id).toBe('b');
  });

  it('falls back to a usable model when the saved one left the catalog', () => {
    expect(pickImageModel([entry('gone', null), entry('b', m('b'))], 'gone')?.id).toBe('b');
    expect(pickImageModel([entry('a', m('a'))], 'unknown')?.id).toBe('a');
  });

  it('has nothing when no model is usable', () => {
    expect(pickImageModel([entry('gone', null)], 'gone')).toBeUndefined();
  });
});
