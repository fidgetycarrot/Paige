import { mkdir } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
for (const name of ['backend', 'frontend']) {
  const result = await Bun.build({ entrypoints: [`src/${name}.ts`], outdir: 'dist', naming: `${name}.js`, target: name === 'backend' ? 'bun' : 'browser', format: 'esm', minify: false });
  if (!result.success) throw new Error(result.logs.join('\n'));
}
