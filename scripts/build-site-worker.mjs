import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientRoot = path.join(root, 'dist', 'client');
const workerRoot = path.join(root, 'dist', 'server');
const assets = {};

function collect(directory, prefix = '') {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, item.name);
    const relative = path.posix.join(prefix, item.name);
    if (item.isDirectory()) collect(fullPath, relative);
    else {
      const extension = path.extname(item.name).toLowerCase();
      const contentType = extension === '.html' ? 'text/html; charset=utf-8'
        : extension === '.js' ? 'text/javascript; charset=utf-8'
          : extension === '.css' ? 'text/css; charset=utf-8'
            : extension === '.svg' ? 'image/svg+xml'
              : extension === '.json' ? 'application/json; charset=utf-8'
                : 'application/octet-stream';
      assets[`/${relative}`] = { body: fs.readFileSync(fullPath, 'utf8'), contentType };
    }
  }
}

collect(clientRoot);
if (!assets['/index.html']) throw new Error('The Vite client build did not produce dist/client/index.html.');
fs.mkdirSync(workerRoot, { recursive: true });
fs.mkdirSync(path.join(root, 'dist', '.openai'), { recursive: true });
fs.copyFileSync(path.join(root, '.openai', 'hosting.json'), path.join(root, 'dist', '.openai', 'hosting.json'));

await build({
  entryPoints: [path.join(root, 'worker', 'app.js')],
  bundle: true,
  minify: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  outfile: path.join(workerRoot, 'index.js'),
  plugins: [{
    name: 'embedded-client-assets',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^virtual:client-assets$/ }, () => ({ path: 'client-assets', namespace: 'generated' }));
      buildApi.onLoad({ filter: /.*/, namespace: 'generated' }, () => ({
        contents: `export const CLIENT_ASSETS = ${JSON.stringify(assets)};`,
        loader: 'js',
      }));
    },
  }],
});

process.stdout.write(`Bundled ${Object.keys(assets).length} client assets into the Sites Worker.\n`);
