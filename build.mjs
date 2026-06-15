// Two-stage build.
//
//   stage 1: bundle src/frontend/app/main.js into a single IIFE string.
//            This is the chunk that ends up between <script>…</script>
//            on every HTML response.
//
//   stage 2: bundle src/index.js (the Worker entry) into dist/index.js.
//            src/frontend/template.js imports virtual:frontend-js for
//            the stage-1 output and ./styles.css for the stylesheet,
//            both as plain text — the inject + text-loader plugins
//            below answer those imports.
//
// Both stages target es2022 and skip minification: the Worker isolate
// has plenty of budget to parse the inlined frontend, and unminified
// output makes the deployable artefact reviewable.

import * as esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';

const watchMode = process.argv.includes('--watch');

async function buildFrontend() {
  const result = await esbuild.build({
    entryPoints: ['src/frontend/app/main.js'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
    legalComments: 'none',
    logLevel: 'info',
  });
  return result.outputFiles[0].text;
}

// esbuild plugin: resolve "virtual:frontend-js" → the stage-1 string.
function injectFrontend(getCode) {
  return {
    name: 'inject-frontend',
    setup(b) {
      b.onResolve({ filter: /^virtual:frontend-js$/ }, () => ({
        path: 'frontend-js', namespace: 'inject',
      }));
      b.onLoad({ filter: /.*/, namespace: 'inject' }, () => ({
        contents: 'export default ' + JSON.stringify(getCode()),
        loader: 'js',
      }));
    },
  };
}

// esbuild plugin: import "./styles.css" → a plain-text export.
const cssAsText = {
  name: 'css-as-text',
  setup(b) {
    b.onLoad({ filter: /\.css$/ }, async (args) => ({
      contents: 'export default ' + JSON.stringify(await readFile(args.path, 'utf8')),
      loader: 'js',
    }));
  },
};

async function buildWorker(frontendCode) {
  return esbuild.build({
    entryPoints: ['src/index.js'],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    outfile: 'dist/index.js',
    legalComments: 'none',
    logLevel: 'info',
    plugins: [injectFrontend(() => frontendCode), cssAsText],
  });
}

async function buildOnce() {
  const start = Date.now();
  const frontendCode = await buildFrontend();
  await buildWorker(frontendCode);
  console.log(`✓ built dist/index.js in ${Date.now() - start}ms (frontend ${frontendCode.length}B)`);
}

if (watchMode) {
  // Naïve watch: rebuild on any src/ change. esbuild has its own
  // watch API but the two-stage pipeline + text-injection means a
  // hand-rolled loop is simpler than wiring two contexts together.
  const { watch } = await import('node:fs');
  await buildOnce();
  watch('src', { recursive: true }, () => {
    buildOnce().catch((e) => console.error(e));
  });
  console.log('… watching src/');
} else {
  await buildOnce();
}
