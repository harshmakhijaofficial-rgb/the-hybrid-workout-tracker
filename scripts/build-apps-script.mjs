import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'apps-script/build');
await mkdir(output, { recursive: true });
const read = file => readFile(path.join(root, file), 'utf8');
const plan = JSON.parse(await read('htdocs/plan.json'));
let html = await read('htdocs/index.html');
const style = await read('htdocs/style.css');
html = html.replace('<link rel="stylesheet" href="./style.css">', `<style>${style}</style>`);
const scriptFiles = [...html.matchAll(/<script defer src="\.\/([^"]+)"><\/script>/g)].map(match => match[1]);
for (const file of scriptFiles) {
  const source = file === 'runtime-config.js' ? "window.HYBRID_STORAGE_MODE = 'sheets';" : await read('htdocs/' + file);
  html = html.replace(`<script defer src="./${file}"></script>`, `<script>${source.replace(/<\/script/gi, '<\\/script')}</script>`);
}
// Inline application scripts run after the document exists; Apps Script supplies google.script.run.
const scripts = [...html.matchAll(/<script>[\s\S]*?<\/script>/g)].map(match => match[0]);
html = html.replace(/\s*<script>[\s\S]*?<\/script>/g, '');
html = html.replace('</body>', scripts.join('\n') + '\n</body>');
const backend = 'var HYBRID_PLAN = ' + JSON.stringify(plan) + ';\n' + await read('apps-script/Code.gs');
await writeFile(path.join(output, 'Code.gs'), backend);
await writeFile(path.join(output, 'Index.html'), html);
await copyFile(path.join(root, 'apps-script/appsscript.json'), path.join(output, 'appsscript.json'));
console.log('Prepared Apps Script Code.gs, Index.html and owner-private manifest in apps-script/build/.');
