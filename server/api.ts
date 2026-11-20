// HTTP API калькулятора: цены mc.ru (кэш в data/prices.json), ИИ-анализ заказа (server/ai.ts),
// история заказов (server/history.ts) и доска задач (server/tasks.ts). Используется и dev-сервером Vite, и боевым server/index.ts;
// вход по паролю проверяется раньше (server/auth.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { refreshPrices } from './mc.ts';
import { aiStatus, cancelJob, createJob, getJob, putImage } from './ai.ts';
import { handleHistory } from './history.ts';
import { handleTasks } from './tasks.ts';
import { clientIp, HttpError, parseJson, readRaw, send, sendEmpty } from './http.ts';
import { AI_LIMITS } from '../src/core/ai.ts';
import { MATERIAL_BY_ID } from '../src/core/materials.ts';
import type { PriceBook } from '../src/core/pricing.ts';

export { readRaw };

// ключ ИИ и пароль для локального запуска — из calc/.env (нет в git и в образе); переменные окружения важнее файла
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch {
  /* файла нет — настройки только из окружения (в проде их передаёт docker compose) */
}

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

/** Пар [материал, толщина] в одном обновлении цен: интерфейс шлёт по 12 (REFRESH_BATCH в src/prices.ts) */
export const REFRESH_MAX_PAIRS = 40;

/**
 * Тело POST /api/prices/refresh → пары для обновления: материал из справочника, толщина — число 0,1…100 мм
 * (своя толщина в интерфейсе — до 100 мм), до 3 знаков, без повторов, не больше 40; прочее отбрасывается.
 * Не осталось ни одной — 400: полный обход mc.ru (105 запросов, антибот) — только scripts/update-prices.ts,
 * а строка вместо толщины («2#», «../x») ушла бы в адрес mc.ru и стёрла бы цены материала.
 */
export function refreshPairs(body: unknown): [string, number][] {
  const raw = typeof body === 'object' && body !== null ? (body as { pairs?: unknown }).pairs : undefined;
  const out: [string, number][] = [];
  const seen = new Set<string>();
  for (const p of Array.isArray(raw) ? raw : []) {
    if (!Array.isArray(p)) continue;
    const [id, t] = p as unknown[];
    if (typeof id !== 'string' || !MATERIAL_BY_ID.has(id) || typeof t !== 'number' || !Number.isFinite(t) || t < 0.1 || t > 100) continue;
    const thickness = Math.round(t * 1000) / 1000;
    const key = `${id}|${thickness}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([id, thickness]);
    if (out.length >= REFRESH_MAX_PAIRS) break;
  }
  if (!out.length) throw new HttpError(400, 'Не указаны толщины для обновления цен');
  return out;
}

const JOB_PATH = /^\/api\/ai\/jobs\/([^/]{1,100})(?:\/images\/(\d{1,3}))?$/;

/** /api/ai/*: статус, задачи анализа, изображения чертежей */
async function handleAi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const method = req.method ?? 'GET';
  const wrongMethod = () => new HttpError(405, 'Метод не поддерживается');
  try {
    if (path === '/api/ai/status') {
      if (method !== 'GET') throw wrongMethod();
      send(res, 200, await aiStatus());
      return;
    }
    if (path === '/api/ai/jobs') {
      if (method !== 'POST') throw wrongMethod();
      // лимит — на сам AiContext; обёртка {"context":…} сверху (браузер проверяет так же, с запасом 1000 байт)
      const body = parseJson(await readRaw(req, AI_LIMITS.contextBytes + 1024));
      send(res, 201, await createJob(body, clientIp(req)));
      return;
    }
    const m = JOB_PATH.exec(path);
    if (!m) throw new HttpError(404, 'Нет такого метода');
    const id = m[1];
    if (m[2] !== undefined) {
      if (method !== 'PUT') throw wrongMethod();
      // задача есть и не завершена — до чтения тела (до 900 КБ в памяти): чужой id — сразу 404, готовая — 409
      const state = getJob(id);
      if (state.status === 'done' || state.status === 'error') throw new HttpError(409, 'Задача уже не принимает изображения');
      putImage(id, Number(m[2]), await readRaw(req, AI_LIMITS.imageBytes));
      sendEmpty(res, 204);
    } else if (method === 'GET') send(res, 200, getJob(id));
    else if (method === 'DELETE') {
      cancelJob(id);
      sendEmpty(res, 204);
    } else throw wrongMethod();
  } catch (e) {
    if (e instanceof HttpError) send(res, e.status, { error: e.message });
    else {
      console.error('[ai] ошибка API:', e);
      send(res, 500, { error: 'Внутренняя ошибка сервера ИИ' });
    }
  }
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
      // тело и пары — до «занято»: неверный запрос сразу 4xx, не занимает обновление и не ходит на mc.ru
      const pairs = refreshPairs(parseJson(await readRaw(req, 16_000)));
      if (busy) {
        send(res, 409, { error: 'Обновление уже идёт' });
        return true;
      }
      busy = true;
      try {
        const { book, errors } = await refreshPrices(loadBook(), pairs);
        mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
        writeFileSync(DATA, JSON.stringify(book));
        send(res, 200, { book, errors });
      } finally {
        busy = false;
      }
      return true;
    }
    if (url.pathname.startsWith('/api/ai/')) {
      await handleAi(req, res, url.pathname);
      return true;
    }
    if (url.pathname === '/api/history' || url.pathname.startsWith('/api/history/')) {
      await handleHistory(req, res, url.pathname);
      return true;
    }
    if (url.pathname === '/api/tasks' || url.pathname.startsWith('/api/tasks/')) {
      await handleTasks(req, res, url);
      return true;
    }
    send(res, 404, { error: 'Нет такого метода' });
  } catch (e) {
    // текст для пользователя — только у HttpError; прочее (ошибки кода, диска) — в лог, наружу общий ответ
    if (res.headersSent) res.end();
    else if (e instanceof HttpError) send(res, e.status, { error: e.message });
    else {
      console.error('[api] ошибка:', e);
      send(res, 500, { error: 'Внутренняя ошибка сервера' });
    }
  }
  return true;
}
