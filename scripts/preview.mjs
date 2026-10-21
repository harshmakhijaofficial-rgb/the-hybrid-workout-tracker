import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(fileURLToPath(new URL('../htdocs/', import.meta.url)));
const port = Number(process.env.PORT || 8788);
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    // Serve at a project subpath as well, to verify GitHub Pages relative URLs.
    let relative = decodeURIComponent(url.pathname).replace(/^\/the-hybrid-workout-tracker(?=\/|$)/, '');
    if (relative === '' || relative.endsWith('/')) relative += 'index.html';
    const file = path.resolve(root, '.' + relative);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': (types[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`FTP webroot preview: http://127.0.0.1:${port}/\nProject path preview: http://127.0.0.1:${port}/the-hybrid-workout-tracker/`));
