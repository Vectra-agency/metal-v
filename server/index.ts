// Боевой сервер: отдаёт собранное приложение (dist/), API цен и ИИ-анализа.
// Запуск: npm run serve  (сборка + старт) или npm start (если dist уже собран)
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './api.ts';
import { aiStartupLine } from './ai.ts';
import { modelCatalog } from './llm.ts';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

const INDEX = join(DIST, 'index.html');

if (!existsSync(INDEX)) {
  console.error('Нет сборки dist/. Выполните: npm run serve');
  process.exit(1);
}

const server = createServer(async (req, res) => {
  try {
    if (await handleApi(req, res)) return;
    const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join(DIST, path);
    if (file.startsWith(DIST) && existsSync(file) && statSync(file).isFile()) {
      const type = TYPES[extname(file)] ?? 'application/octet-stream';
      // index.html — с проверкой при каждом открытии: после выкладки в нём новые имена /assets/*
      res.writeHead(200, file === INDEX ? { 'Content-Type': type, 'Cache-Control': 'no-cache' } : { 'Content-Type': type });
      res.end(readFileSync(file));
      return;
    }
    // файла нет: скрипт или стиль старой сборки (/assets/*, адрес с расширением) — 404, а не index.html:
    // HTML под именем скрипта nginx закэшировал бы на год; адрес страницы приложения — index.html
    const ext = extname(path);
    if (path.startsWith('/assets/') || (ext && ext !== '.html')) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' });
    res.end(readFileSync(INDEX));
  } catch {
    // кривой адрес (%E0%A4%A) не должен ронять процесс необработанным исключением
    if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
  }
}).listen(PORT, () => {
  console.log(`Калькулятор: http://localhost:${PORT}`);
  console.log(aiStartupLine());
  void modelCatalog(); // справочник моделей заранее: первый /api/ai/status не ждёт ~400 КБ каталога
});

// docker stop шлёт SIGTERM: выходим сразу, а не через 10 с по SIGKILL (задачи ИИ живут в памяти и так теряются)
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
