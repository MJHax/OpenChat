import type { ReuseDraft } from '../lib/reuse';

export function Library(_props: { onReuse(d: ReuseDraft): void }) {
  return (
    <div className="page">
      <div className="page-inner"><h1>Library</h1></div>
    </div>
  );
}
