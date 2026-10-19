import { describe, it, expect } from 'vitest';
import { tiltFromPointer } from './motion';

describe('tiltFromPointer', () => {
  it('is flat at the center', () => {
    expect(tiltFromPointer(0.5, 0.5, 12)).toEqual({ rx: 0, ry: 0, gx: 50, gy: 50 });
  });

  it('tilts toward the top-right corner', () => {
    expect(tiltFromPointer(1, 0, 12)).toEqual({ rx: 6, ry: 6, gx: 100, gy: 0 });
  });

  it('clamps a pointer outside the card', () => {
    expect(tiltFromPointer(1.4, -0.2, 10)).toEqual({ rx: 5, ry: 5, gx: 100, gy: 0 });
  });
});
