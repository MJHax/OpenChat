import { snapVideoSettings, usd, videoPrice, type VideoModel, type VideoSettings } from '../../../shared/videoModels';
import type { Attachment, MediaLibraryModel } from '../../../shared/types';
import { FrameSlot } from './FrameSlot';
import { framesProblem } from '../lib/videoUi';
import { Volume2, VolumeX } from 'lucide-react';

interface Props {
  library: MediaLibraryModel[];
  model: VideoModel | null;
  onModelChange(id: string): void;
  settings: VideoSettings;
  onSettings(s: VideoSettings): void;
  prompt: string;
  onPrompt(p: string): void;
  start: Attachment | null;
  end: Attachment | null;
  onStart(a: Attachment | null): void;
  onEnd(a: Attachment | null): void;
  onStartAspect(ratio: number): void;
  /** Something outside the composer that stops a send (no key, a clip already rendering). */
  blocked: string | null;
  onGenerate(): void;
  onError(message: string): void;
}

/** Start and end photos, the prompt, and the clip's settings, with its exact price on the button. */
export function VideoComposer(p: Props) {
  const m = p.model;
  const photos = (p.start ? 1 : 0) + (p.end ? 1 : 0);
  const price = m ? videoPrice(m, p.settings, photos) : null;
  const problem = m ? framesProblem(m, !!p.start, !!p.end) : null;
  const reason = p.blocked
    ?? (!m ? 'Add a video model in the Model Library first.' : null)
    ?? (problem ? `This model ${problem}.` : null)
    ?? (!p.prompt.trim() ? '' : null);
  const set = (change: Partial<VideoSettings>) => m && p.onSettings(snapVideoSettings(m, { ...p.settings, ...change }));
  const label = price?.cost == null ? 'Generate · price after generating' : `Generate · ${price.estimated ? '~' : ''}${usd(price.cost)}`;

  return (
    <div className="composer">
      <div className="composer-box video-composer">
        <div className="frame-row">
          <FrameSlot label="Start" photo={p.start} onPhoto={p.onStart} onAspect={p.onStartAspect} onError={p.onError}
            disabledReason={m && !m.frames.first ? "This model can't start from a photo" : null} />
          <FrameSlot label="End" photo={p.end} onPhoto={p.onEnd} onError={p.onError}
            disabledReason={m && !m.frames.last ? "This model can't end on a photo" : null} />
        </div>
        <textarea rows={2} placeholder="Describe what happens…" value={p.prompt} onChange={(e) => p.onPrompt(e.target.value)} />
        <div className="row image-controls">
          <select aria-label="Video model" value={m?.id ?? ''} onChange={(e) => p.onModelChange(e.target.value)} disabled={p.library.length === 0}>
            {p.library.map((e) => {
              const vm = e.model as VideoModel | null;
              const why = !vm ? 'not offered any more' : framesProblem(vm, !!p.start, !!p.end);
              return <option key={e.id} value={e.id} disabled={!!why}>{e.displayName}{why ? ` (${why})` : ''}</option>;
            })}
          </select>
          {m && m.durations.length > 0 && (
            <select aria-label="Length" value={p.settings.duration} onChange={(e) => set({ duration: Number(e.target.value) })}>
              {m.durations.map((d) => <option key={d} value={d}>{d}s</option>)}
            </select>
          )}
          {m && m.resolutions.length > 0 && (
            <select aria-label="Quality" value={p.settings.resolution ?? ''} onChange={(e) => set({ resolution: e.target.value })}>
              {m.resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          )}
          {m && m.aspects.length > 0 && (
            <select aria-label="Aspect ratio" value={p.settings.aspect} onChange={(e) => set({ aspect: e.target.value })}>
              {m.aspects.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          )}
          {m?.sound && (
            <button className="toggle" aria-pressed={p.settings.sound} onClick={() => set({ sound: !p.settings.sound })}>
              {p.settings.sound ? <><Volume2 size={14} /> Sound on</> : <><VolumeX size={14} /> Sound off</>}
            </button>
          )}
          <span className="spacer" />
          <button className="primary" disabled={reason !== null} onClick={p.onGenerate}>{label}</button>
        </div>
        {price && (
          <div className="composer-hint">
            {price.breakdown}
            {price.nextSteps.map((n) => ` · ${n.label === 'sound' ? 'sound' : n.label} would add ${usd(n.extra)}`).join('')}
          </div>
        )}
        {reason && <div className="composer-hint">{reason}</div>}
      </div>
    </div>
  );
}
