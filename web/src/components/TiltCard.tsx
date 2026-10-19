import { useRef, useState, type HTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { motion, useMotionTemplate, useMotionValue, useSpring } from 'motion/react';
import { SPRING_MOUSE, tiltFromPointer } from '../lib/motion';

export interface TiltCardProps extends Omit<HTMLAttributes<HTMLElement>, 'onDrag' | 'onDragStart' | 'onDragEnd' | 'onAnimationStart'> {
  children: ReactNode;
  /** Largest lean in degrees. */
  max?: number;
  glare?: boolean;
  as?: 'div' | 'button' | 'a' | 'li';
  href?: string;
  type?: 'button' | 'submit';
  disabled?: boolean;
}

/** Leans in 3D toward the cursor with a soft glare that follows it. Port of the BeUI TiltCard. */
export function TiltCard({ children, className, max = 12, glare = true, as = 'div', onMouseMove, onMouseLeave, onMouseEnter, ...rest }: TiltCardProps) {
  const ref = useRef<HTMLElement>(null);
  // Decided on each enter, so turning tilt off in Settings or the OS takes effect without a re-render.
  const [enabled, setEnabled] = useState(false);
  const rx = useMotionValue(0);
  const ry = useMotionValue(0);
  const gx = useMotionValue(50);
  const gy = useMotionValue(50);
  const srx = useSpring(rx, SPRING_MOUSE);
  const sry = useSpring(ry, SPRING_MOUSE);
  const transform = useMotionTemplate`perspective(1000px) rotateX(${srx}deg) rotateY(${sry}deg)`;
  const glareBg = useMotionTemplate`radial-gradient(circle at ${gx}% ${gy}%, var(--glare-c, var(--glare)), transparent 50%)`;

  const enter = (e: MouseEvent<HTMLElement>) => {
    setEnabled(window.matchMedia('(hover: hover) and (pointer: fine)').matches && document.documentElement.dataset.tilt !== 'off');
    onMouseEnter?.(e);
  };
  const move = (e: MouseEvent<HTMLElement>) => {
    onMouseMove?.(e);
    const el = ref.current;
    if (!el || !enabled) return;
    const r = el.getBoundingClientRect();
    const t = tiltFromPointer((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, max);
    rx.set(t.rx);
    ry.set(t.ry);
    gx.set(t.gx);
    gy.set(t.gy);
  };
  const leave = (e: MouseEvent<HTMLElement>) => {
    onMouseLeave?.(e);
    rx.set(0);
    ry.set(0);
  };

  const Tag = motion[as] as typeof motion.div;
  return (
    <Tag
      ref={ref as never}
      {...(rest as object)}
      className={`tilt${className ? ` ${className}` : ''}`}
      style={{ transform, transformStyle: 'preserve-3d' }}
      onMouseEnter={enter}
      onMouseMove={move}
      onMouseLeave={leave}
    >
      {children}
      {glare && enabled && <motion.span aria-hidden className="glare" style={{ background: glareBg }} />}
    </Tag>
  );
}
