// HTTP API калькулятора: цены mc.ru (кэш в data/prices.json).
// Используется и dev-сервером Vite, и боевым server/index.ts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { refreshPrices } from './mc.ts';
import type { PriceBook } from '../src/core/pricing.ts';

const DATA = new URL('../data/prices.json', import.meta.url);
const SNAPSHOT = new URL('../public/prices.json', import.meta.url);

function loadBook(): PriceBook {
  for (const f of [DATA, SNAPSHOT]) {
    if (existsSync(f)) {
      try {
        return JSON.parse(readFileSync(f, 'utf8'));
      } catch {
        /* битый файл — пробуем следующий */
      }
    }
  }
  return { updatedAt: null, region: 'Санкт-Петербург', materials: {} };
}

function send(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : {};
}

let busy = false;

/** Возвращает true, если запрос обработан */
export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return false;
  try {
    // проверка живости для docker и деплоя: version — коммит сборки (GIT_SHA)
    if (url.pathname === '/api/health') {
      send(res, 200, { ok: true, version: process.env.GIT_SHA ?? 'dev' });
      return true;
    }
    if (url.pathname === '/api/prices' && req.method === 'GET') {
      send(res, 200, loadBook());
      return true;
    }
    if (url.pathname === '/api/prices/refresh' && req.method === 'POST') {
      if (busy) {
        send(res, 409, { error: 'Обновление уже идёт' });
        return true;
      }
      busy = true;
      try {
        const body = await readBody(req);
        const pairs: [string, number][] | null = Array.isArray(body.pairs) && body.pairs.length ? body.pairs.slice(0, 40) : null;
        const { book, errors } = await refreshPrices(loadBook(), pairs);
        mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
        writeFileSync(DATA, JSON.stringify(book));
        send(res, 200, { book, errors });
      } finally {
        busy = false;
      }
      return true;
    }
    send(res, 404, { error: 'Нет такого метода' });
  } catch (e) {
    send(res, 500, { error: (e as Error).message });
  }
  return true;
}
