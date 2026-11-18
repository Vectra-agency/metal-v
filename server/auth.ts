// Вход на сайт по общему паролю (SITE_PASSWORD). После входа браузер получает подписанную cookie
// на 30 дней — пароль снова не спрашивается, пока она не истечёт или пароль на сервере не сменят.
// Без cookie: страницы — форма входа, API — 401 JSON (браузер предложит войти снова).
// В проде (NODE_ENV=production) без SITE_PASSWORD сайт закрыт: форма входа говорит, что пароль не задан.
// Локально (npm start, npm run dev) без SITE_PASSWORD вход не нужен.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { clientIp, readRaw, send } from './http.ts';

export const AUTH_COOKIE = 'mc_auth';
export const AUTH_DAYS = 30;
const MAX_AGE_S = AUTH_DAYS * 24 * 3600;
const FAIL_WINDOW_MS = 15 * 60_000;
const FAIL_LIMIT = 10; // неверных паролей с одного адреса за 15 минут
const FAIL_DELAY_MS = 400;

export interface AuthConfig {
  password: string | null;
  required: boolean;
}

export function authConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const password = env.SITE_PASSWORD?.trim() || null;
  return { password, required: !!password || env.NODE_ENV === 'production' };
}

// ключ подписи из пароля: сменили пароль — все выданные cookie недействительны
const keyOf = (password: string, secret = process.env.AUTH_SECRET ?? '') => createHash('sha256').update(`metal-v|auth|${password}|${secret}`).digest();
const mac = (key: Buffer, payload: string) => createHmac('sha256', key).update(payload).digest('base64url');

/** Значение cookie: «v1.<срок, unix-секунды>.<подпись>» */
export function signToken(password: string, expiresAtS: number): string {
  const payload = `v1.${expiresAtS}`;
  return `${payload}.${mac(keyOf(password), payload)}`;
}

/** Срок действия cookie (unix-секунды), если подпись верна и срок не истёк; иначе null */
export function verifyToken(password: string, token: string | undefined, nowS = Math.floor(Date.now() / 1000)): number | null {
  const m = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token ?? '');
  if (!m) return null;
  const exp = Number(m[1]);
  if (!(exp > nowS)) return null;
  const want = Buffer.from(mac(keyOf(password), `v1.${m[1]}`));
  const got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got) ? exp : null;
}

/** Пароль совпал (сравнение за постоянное время, длина пароля не утекает) */
export function passwordOk(password: string, input: string): boolean {
  const a = createHash('sha256').update(password).digest();
  const b = createHash('sha256').update(input).digest();
  return timingSafeEqual(a, b);
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Запрос пришёл по HTTPS (за nginx — X-Forwarded-Proto): cookie с Secure */
const isHttps = (req: IncomingMessage) => req.headers['x-forwarded-proto'] === 'https' || !!(req.socket as { encrypted?: boolean }).encrypted;

function cookieHeader(req: IncomingMessage, value: string, maxAge: number): string {
  return `${AUTH_COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`;
}

/** Куда вернуть после входа: только путь этого сайта */
export function safeNext(v: unknown): string {
  const s = typeof v === 'string' ? v : '';
  return /^\/(?![/\\])[^\s]*$/.test(s) && s.length <= 500 && !s.startsWith('/api/') ? s : '/';
}

// ---------- неверные пароли ----------

const fails = new Map<string, number[]>();

function recentFails(ip: string, now: number): number[] {
  // перебор с множества адресов не раздувает память: старые записи чистим, когда их много
  if (fails.size > 5000) for (const [k, v] of fails) if (now - v[v.length - 1] >= FAIL_WINDOW_MS) fails.delete(k);
  const list = (fails.get(ip) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
  if (list.length) fails.set(ip, list);
  else fails.delete(ip);
  return list;
}

export function resetAuthForTests(): void {
  fails.clear();
}

// ---------- страница входа ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function loginPage(o: { error?: string; next?: string; disabled?: boolean } = {}): string {
  const form = o.disabled
    ? `<p class="err">На сервере не задан пароль входа (SITE_PASSWORD) — сайт закрыт. Администратору: см. DEPLOY.md, раздел «Вход по паролю».</p>`
    : `<form method="post" action="/api/auth/login">
      <input type="hidden" name="next" value="${esc(o.next ?? '/')}">
      <label for="password">Пароль</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus${o.error ? ' aria-invalid="true" aria-describedby="err"' : ''}>
      ${o.error ? `<p id="err" class="err" role="alert">${esc(o.error)}</p>` : ''}
      <button type="submit">Войти</button>
      <p class="hint">На этом устройстве пароль спросим снова через ${AUTH_DAYS} дней.</p>
    </form>`;
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Вход — Расчёт деталей</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect x='3' y='8' width='26' height='16' rx='2' fill='%2364748b'/%3E%3C/svg%3E">
<style>
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --fg: #0f172a; --muted: #64748b; --border: #e2e8f0; --accent: #0f172a; --accent-fg: #fff; --danger: #b91c1c; --ring: #94a3b8; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b0f17; --card: #121826; --fg: #e5e7eb; --muted: #94a3b8; --border: #263044; --accent: #e5e7eb; --accent-fg: #0b0f17; --danger: #f87171; --ring: #64748b; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--fg);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { width: 100%; max-width: 360px; background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 28px 24px; }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; font-weight: 600; }
  .brand svg { width: 28px; height: 28px; fill: var(--muted); }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 20px; font-size: 14px; }
  label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; }
  input[type=password] { width: 100%; height: 40px; padding: 0 12px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: inherit; font: inherit; }
  input[type=password]:focus { outline: 2px solid var(--ring); outline-offset: 1px; }
  input[aria-invalid=true] { border-color: var(--danger); }
  button { margin-top: 14px; width: 100%; height: 40px; border: 0; border-radius: 8px; background: var(--accent); color: var(--accent-fg); font: inherit; font-weight: 600; cursor: pointer; }
  button:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  .err { color: var(--danger); font-size: 14px; margin: 8px 0 0; }
  .hint { color: var(--muted); font-size: 13px; margin: 12px 0 0; }
</style>
</head>
<body>
<main>
  <div class="brand"><svg viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="8" width="26" height="16" rx="2"/></svg>Расчёт деталей</div>
  <h1>Вход</h1>
  <p class="sub">Калькулятор и история заказов доступны по паролю.</p>
  ${form}
</main>
</body>
</html>`;
}

function sendPage(res: ServerResponse, code: number, html: string, headers: Record<string, string> = {}) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', ...headers });
  res.end(html);
}

/** Тело формы входа: application/x-www-form-urlencoded или JSON */
function loginBody(raw: Buffer, type: string | undefined): { password: string; next: string } {
  const text = raw.toString('utf8');
  if ((type ?? '').includes('json')) {
    try {
      const j = JSON.parse(text) as { password?: unknown; next?: unknown };
      return { password: typeof j.password === 'string' ? j.password : '', next: safeNext(j.next) };
    } catch {
      return { password: '', next: '/' };
    }
  }
  const f = new URLSearchParams(text);
  return { password: f.get('password') ?? '', next: safeNext(f.get('next')) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function login(req: IncomingMessage, res: ServerResponse, cfg: AuthConfig): Promise<void> {
  const json = String(req.headers['content-type'] ?? '').includes('json');
  const fail = (code: number, error: string, next = '/') =>
    json ? send(res, code, { error, auth: 'required' }) : sendPage(res, code, loginPage({ error, next, disabled: !cfg.password }));
  if (req.method !== 'POST') return fail(405, 'Метод не поддерживается');
  if (!cfg.password) return fail(503, 'На сервере не задан пароль входа (SITE_PASSWORD)');
  const ip = clientIp(req);
  const now = Date.now();
  const recent = recentFails(ip, now);
  if (recent.length >= FAIL_LIMIT) {
    const wait = Math.ceil((FAIL_WINDOW_MS - (now - recent[0])) / 60_000);
    return fail(429, `Слишком много неверных попыток — попробуйте через ${wait} мин.`);
  }
  const body = loginBody(await readRaw(req, 4096), req.headers['content-type']);
  if (!body.password || !passwordOk(cfg.password, body.password)) {
    recent.push(now);
    fails.set(ip, recent);
    console.warn(`[auth] неверный пароль с ${ip} (${recent.length} за 15 мин)`);
    await sleep(FAIL_DELAY_MS);
    return fail(401, 'Неверный пароль', body.next);
  }
  fails.delete(ip);
  const cookie = cookieHeader(req, signToken(cfg.password, Math.floor(now / 1000) + MAX_AGE_S), MAX_AGE_S);
  if (json) send(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  else {
    res.writeHead(303, { Location: body.next, 'Set-Cookie': cookie, 'Cache-Control': 'no-store' });
    res.end();
  }
}

function logout(req: IncomingMessage, res: ServerResponse): void {
  const clear = cookieHeader(req, '', 0);
  if (req.method === 'POST' && String(req.headers['content-type'] ?? '').includes('json')) send(res, 200, { ok: true }, { 'Set-Cookie': clear });
  else {
    res.writeHead(303, { Location: '/', 'Set-Cookie': clear, 'Cache-Control': 'no-store' });
    res.end();
  }
}

/** Адрес страницы приложения (а не файл сборки и не API): без cookie показываем форму входа */
const isPage = (path: string) => !path.startsWith('/assets/') && !/\.[a-z0-9]{1,8}$/i.test(path.replace(/\.html$/i, ''));

/**
 * Проверка входа перед всем остальным. true — ответ уже отправлен (вход, выход, форма, 401);
 * false — пускаем дальше (вход не нужен или cookie верна).
 */
export async function authGate(req: IncomingMessage, res: ServerResponse, cfg: AuthConfig = authConfig()): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  if (path === '/api/health') return false; // проверка живости docker и деплоя
  if (!cfg.required) {
    if (path === '/api/auth/status') {
      send(res, 200, { enabled: false, expiresAt: null });
      return true;
    }
    return false;
  }
  if (path === '/api/auth/login') {
    await login(req, res, cfg);
    return true;
  }
  if (path === '/api/auth/logout') {
    logout(req, res);
    return true;
  }
  const exp = cfg.password ? verifyToken(cfg.password, cookies(req)[AUTH_COOKIE]) : null;
  if (exp != null) {
    if (path === '/api/auth/status') {
      send(res, 200, { enabled: true, expiresAt: new Date(exp * 1000).toISOString() });
      return true;
    }
    return false;
  }
  const header = { 'X-Auth-Required': '1' };
  if (path.startsWith('/api/')) send(res, 401, { error: 'Нужно войти: срок входа истёк или пароль сменили — обновите страницу', auth: 'required' }, header);
  else if ((req.method === 'GET' || req.method === 'HEAD') && isPage(path)) {
    sendPage(res, 401, loginPage({ next: path + url.search, disabled: !cfg.password }), header);
  } else {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...header });
    res.end('Нужно войти');
  }
  return true;
}

export function authStartupLine(cfg: AuthConfig = authConfig()): string {
  if (!cfg.required) return 'Вход: без пароля (SITE_PASSWORD не задан, не прод)';
  if (!cfg.password) return 'Вход: ЗАКРЫТ — в проде не задан SITE_PASSWORD, войти нельзя';
  return `Вход: по паролю, вход действует ${AUTH_DAYS} дней`;
}
