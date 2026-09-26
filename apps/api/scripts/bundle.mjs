// Bundel produkcyjny API: kod źródłowy (w tym pakiety @nova/* w TS) → dist/*.js dla czystego Node.
// Zależności z node_modules pozostają zewnętrzne (instalowane przez `pnpm install --prod`).
import { copyFileSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith('@nova/'));

await build({
  absWorkingDir: new URL('..', import.meta.url).pathname,
  entryPoints: { main: 'src/main.ts', cli: 'src/db/cli.ts' },
  outdir: 'dist',
  bundle: true,
  splitting: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external,
  logLevel: 'info',
});

// Wątek odczytu PDF jest ładowany w czasie działania przez `new URL('./pdf-worker.mjs', import.meta.url)`.
copyFileSync(
  new URL('../src/documents/pdf-worker.mjs', import.meta.url),
  new URL('../dist/pdf-worker.mjs', import.meta.url),
);
