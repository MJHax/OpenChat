import { useLayoutEffect, useRef, useState } from 'react';

/** A row of mutually exclusive buttons, e.g. the time range or a chart's metric. A pill slides to the chosen one. */
export function Segmented<T extends string>({ options, value, onChange, label }: {
  options: { id: T; label: string }[];
  value: T;
  onChange(value: NoInfer<T>): void;
  label: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const on = root.current?.querySelector<HTMLElement>('button[aria-pressed="true"]');
      setPill(on ? { left: on.offsetLeft, width: on.offsetWidth } : null);
    };
    place();
    // Labels change width once the web font loads.
    void document.fonts?.ready.then(place);
  }, [value, options.length]);
  return (
    <div className="seg" role="group" aria-label={label} ref={root}>
      {pill && <span className="pill" style={pill} aria-hidden />}
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={o.id === value} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}
