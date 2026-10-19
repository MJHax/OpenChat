import { useContext, useEffect, useRef, useState, type ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { FilePanelContext } from './FilePanelContext';
import { saveableCode, snippetName } from '../lib/filePreview';

function CodeBlock({ node: _node, children, ...props }: ComponentProps<'pre'> & { node?: unknown }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const panel = useContext(FilePanelContext);
  const [saveable, setSaveable] = useState(false);
  useEffect(() => setSaveable(!!panel && saveableCode(ref.current?.innerText ?? '')), [panel, children]);
  // The language rehype-highlight found, read from the rendered code element's class.
  const [lang, setLang] = useState<string | null>(null);
  useEffect(() => setLang(/language-([\w+-]+)/.exec(ref.current?.querySelector('code')?.className ?? '')?.[1] ?? null), [children]);
  const copy = async () => {
    await navigator.clipboard.writeText(ref.current?.innerText ?? '');
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const save = () => {
    const lang = /language-([\w+-]+)/.exec(ref.current?.querySelector('code')?.className ?? '')?.[1];
    const name = snippetName(lang);
    panel?.open(name, null, { name, content: (ref.current?.innerText ?? '').replace(/\n$/, ''), complete: true });
  };
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{lang ?? 'code'}</span>
        <span className="code-actions">
          {saveable && <button className="copy-code" onClick={save}>Save as file</button>}
          <button className="copy-code" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        </span>
      </div>
      <pre ref={ref} {...props}>{children}</pre>
    </div>
  );
}

/** Links open in a new tab so following one never navigates away from OpenChat. */
function Link({ node: _node, ...props }: ComponentProps<'a'> & { node?: unknown }) {
  return <a {...props} target="_blank" rel="noopener noreferrer" />;
}

export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ pre: CodeBlock, a: Link }}>
      {text}
    </ReactMarkdown>
  );
}
