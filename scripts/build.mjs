import { mkdir, readdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'docs');
await mkdir(output, { recursive: true });
for (const entry of await readdir(path.join(root, 'public'), { withFileTypes: true })) {
  if (entry.isFile()) await copyFile(path.join(root, 'public', entry.name), path.join(output, entry.name));
}
const plan = JSON.parse(await readFile(path.join(root, 'plan.json'), 'utf8'));
await writeFile(path.join(output, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
const connection = JSON.parse(await readFile(path.join(root, 'apps-script/connection.json'), 'utf8'));
if (connection.dashboard_url && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(connection.dashboard_url)) throw Error('Invalid private Sheets dashboard URL.');
await writeFile(path.join(output, 'runtime-config.js'), "window.HYBRID_STORAGE_MODE = 'browser';\nwindow.HYBRID_SHEETS_DASHBOARD_URL = " + JSON.stringify(connection.dashboard_url) + ';\n');
await writeFile(path.join(output, '.nojekyll'), '');
console.log('Built browser dashboard in docs/ (ready for GitHub Pages).');
