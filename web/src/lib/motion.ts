// Easing and spring settings shared by every animation, adapted from the BeUI TiltCard the design started from.

export const EASE_OUT = [0.16, 1, 0.3, 1] as const;
export const EASE_SPRING_CSS = 'cubic-bezier(0.34, 1.56, 0.64, 1)';

export const SPRING_PRESS = { type: 'spring', stiffness: 500, damping: 30, mass: 0.6 } as const;
export const SPRING_PANEL = { type: 'spring', stiffness: 420, damping: 40, mass: 0.5 } as const;
/** Follows the cursor on tilt cards. */
export const SPRING_MOUSE = { stiffness: 200, damping: 15, mass: 0.3 } as const;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * A tilt card's rotation (degrees) and glare position (percent) for a pointer at (px, py), each 0–1 across the card.
 * The card leans toward the pointer: right edge turns rotateY positive, top edge turns rotateX positive.
 */
export function tiltFromPointer(px: number, py: number, max: number): { rx: number; ry: number; gx: number; gy: number } {
  const x = clamp01(px);
  const y = clamp01(py);
  return { rx: (0.5 - y) * max, ry: (x - 0.5) * max, gx: x * 100, gy: y * 100 };
}
