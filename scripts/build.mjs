import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'htdocs');
// htdocs is the source and deployable webroot; no duplicate output tree is needed.
for (const file of ['index.html', 'style.css', 'app.js', 'storage.js', 'schedule.js']) {
  await readFile(path.join(output, file));
}
JSON.parse(await readFile(path.join(output, 'plan.json'), 'utf8'));
const connection = JSON.parse(await readFile(path.join(root, 'apps-script/connection.json'), 'utf8'));
if (connection.dashboard_url && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(connection.dashboard_url)) throw Error('Invalid private Sheets dashboard URL.');
await writeFile(path.join(output, 'runtime-config.js'), "window.HYBRID_STORAGE_MODE = 'browser';\nwindow.HYBRID_SHEETS_DASHBOARD_URL = " + JSON.stringify(connection.dashboard_url) + ';\n');
await writeFile(path.join(output, '.nojekyll'), '');
console.log('htdocs/ is ready for FTP hosting and GitHub Pages.');
