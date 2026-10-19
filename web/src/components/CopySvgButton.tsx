import { useState } from 'react';

/** Copies an SVG's markup, to paste straight into code. */
export function CopySvgButton({ src, className }: { src: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  async function copy() {
    try {
      await navigator.clipboard.writeText(await (await fetch(src)).text());
      setState('copied');
    } catch {
      setState('failed');
    }
    setTimeout(() => setState('idle'), 1500);
  }
  return <button className={className} onClick={copy}>{state === 'copied' ? 'Copied' : state === 'failed' ? "Couldn't copy" : 'Copy SVG'}</button>;
}
