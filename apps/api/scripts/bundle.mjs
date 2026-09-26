// Bundel produkcyjny API: kod źródłowy (w tym pakiety @nova/* w TS) → dist/*.js dla czystego Node.
// Zależności z node_modules pozostają zewnętrzne (instalowane przez `pnpm install --prod`).
import { readFileSync } from 'node:fs';
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
