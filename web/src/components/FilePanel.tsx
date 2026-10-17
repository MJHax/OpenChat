import { useEffect, useMemo, useRef, useState } from 'react';
import hljs from 'highlight.js/lib/common';
import { fileKind, type FileBlock, type FileVersion } from '../../../shared/files';
import { csvRows, prepareHtml } from '../lib/filePreview';
import { Markdown } from './Markdown';

interface Props {
  name: string;
  /** Every version of the file on the path (plus a compare column's reply); empty for a snippet. */
  versions: FileVersion[];
  /** 1-based version to show first. */
  initialVersion: number;
  /** A file that has no versions: a streaming one, or a code block saved as a file. */
  adhoc: FileBlock | null;
  images: Map<string, string>;
  onDownload(file: FileBlock): void;
  onClose(): void;
}

const RENDERED = new Set(['html', 'svg', 'md', 'csv']);
const SANDBOX = 'allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox';

function Highlighted({ code, name }: { code: string; name: string }) {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const lang = hljs.getLanguage(ext) ? ext : 'plaintext';
  const html = useMemo(() => hljs.highlight(code, { language: lang }).value, [code, lang]);
  return <pre className="file-code"><code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre>;
}

function SvgView({ content }: { content: string }) {
  const url = useMemo(() => URL.createObjectURL(new Blob([content], { type: 'image/svg+xml' })), [content]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <div className="file-svg"><img src={url} alt="" /></div>;
}

function CsvView({ content }: { content: string }) {
  const { rows, more } = useMemo(() => csvRows(content), [content]);
  return (
    <div className="file-csv">
      <table>
        <tbody>
          {rows.map((r, i) => <tr key={i}>{r.map((c, j) => (i === 0 ? <th key={j}>{c}</th> : <td key={j}>{c}</td>))}</tr>)}
        </tbody>
      </table>
      {more > 0 && <p className="muted small">Showing {rows.length} of {rows.length + more} rows.</p>}
    </div>
  );
}

/** The side panel: a generated file running live (HTML), rendered (SVG, Markdown, CSV) or as highlighted code. */
export function FilePanel({ name, versions, initialVersion, adhoc, images, onDownload, onClose }: Props) {
  const [version, setVersion] = useState(initialVersion);
  const [code, setCode] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => setVersion(initialVersion), [name, initialVersion]);
  useEffect(() => setCode(false), [name]);

  const file = adhoc ?? versions[Math.min(version, versions.length) - 1]?.file;
  const kind = fileKind(name);
  const srcDoc = useMemo(() => (file && kind === 'html' ? prepareHtml(file.content, images) : ''), [file, kind, images]);
  if (!file) return null;
  const showCode = code || !RENDERED.has(kind);

  return (
    <aside className="file-panel" aria-label={`File ${name}`}>
      <div className="file-panel-head">
        <span className="file-panel-name" title={name}>{name}</span>
        {!adhoc && versions.length > 1 && (
          <span className="file-versions" role="group" aria-label="Version">
            {versions.map((v) => (
              <button key={v.version} className={`link${v.version === version ? ' on' : ''}`} aria-pressed={v.version === version} onClick={() => setVersion(v.version)}>
                v{v.version}
              </button>
            ))}
          </span>
        )}
        <span className="spacer" />
        {RENDERED.has(kind) && (
          <button className="link" onClick={() => setCode(!code)}>{code ? 'Preview' : 'Code'}</button>
        )}
        {kind === 'html' && !showCode && (
          <button className="link" onClick={() => frame.current?.contentWindow?.postMessage('openchat:print', '*')}>Print / Save as PDF</button>
        )}
        <button className="link" onClick={() => onDownload(file)}>Download</button>
        <button className="icon" onClick={onClose} aria-label="Close file" title="Close">✕</button>
      </div>
      {!file.complete && <div className="file-panel-note muted small">Incomplete. The reply stopped before this file finished.</div>}
      <div className="file-panel-body">
        {showCode ? <Highlighted code={file.content} name={name} />
          : kind === 'html' ? <iframe ref={frame} title={name} sandbox={SANDBOX} srcDoc={srcDoc} />
          : kind === 'svg' ? <SvgView content={file.content} />
          : kind === 'md' ? <div className="file-md msg-body"><Markdown text={file.content} /></div>
          : <CsvView content={file.content} />}
      </div>
    </aside>
  );
}
