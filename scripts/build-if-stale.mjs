// Run by `npm start`: builds the web app only when dist/ is missing or older than the files it is built from,
// so starting again after no changes skips the build.
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SOURCES = ['web', 'shared', 'vite.config.ts', 'package-lock.json'];
const OUTPUT = 'dist/index.html';

function newest(path) {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return Math.max(0, ...readdirSync(path).map((name) => newest(join(path, name))));
}

const built = existsSync(OUTPUT) ? statSync(OUTPUT).mtimeMs : 0;
if (built === 0 || SOURCES.some((s) => newest(s) > built)) {
  console.log(built === 0 ? 'Building the web app…' : 'The web app changed; rebuilding…');
  execSync('npx vite build', { stdio: 'inherit' });
}
