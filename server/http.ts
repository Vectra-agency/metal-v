// Общие помощники HTTP для API: ответы JSON, чтение тела с лимитом, адрес клиента за nginx.
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Ошибка HTTP API с текстом для пользователя */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function send(res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

export function sendEmpty(res: ServerResponse, code: number) {
  res.writeHead(code, { 'Cache-Control': 'no-store' });
  res.end();
}

/** Тело запроса → JSON; не разбирается — 400 */
export function parseJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Тело запроса — не JSON');
  }
}

/** Тело запроса не больше limit байт, иначе 413. Лишнее не копим; дочитывает и выбрасывает остаток Node */
export function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const tooLarge = () => new HttpError(413, `Слишком большой запрос: больше ${Math.round(limit / 1000)} КБ`);
  if (Number(req.headers['content-length']) > limit) return Promise.reject(tooLarge());
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        reject(tooLarge());
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/** Адрес клиента: за nginx — X-Real-IP (его ставит nginx), иначе адрес соединения */
export function clientIp(req: IncomingMessage): string {
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  // в X-Forwarded-For последний адрес добавлен ближайшим прокси, первые клиент может подделать
  const xff = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return xff[xff.length - 1] ?? req.socket.remoteAddress ?? 'unknown';
}
