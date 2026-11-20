// Тесты доски задач: node scripts/test-tasks.ts
// Хранилище на сервере через HTTP-обработчик (во временной папке): создание, порядок в колонках, перенос, правка
// с защитой от затирания, вопросы агента, комментарии, вложения (тип по содержимому), удаление, перечитывание с диска;
// чистые помощники src/core/tasks.ts (следующая задача для агента, Markdown).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { columnTasks, nextTask, slug, taskMarkdown, type Task } from '../src/core/tasks.ts';
import { handleTasks, peopleOf, setTasksDir, sniffType } from '../server/tasks.ts';

let passed = 0;
const failed: string[] = [];
async function test(name: string, fn: () => unknown) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed.push(name);
    console.log(`  ✗ ${name}\n    ${String((e as Error).stack ?? e).split('\n').slice(0, 12).join('\n    ')}`);
  }
}

interface Res {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  json: () => any;
}

function fakeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const raw = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return Object.assign(Readable.from([raw]), { method, url, headers: {}, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
}

/** Ответ — настоящий поток (файлы вложений сервер отдаёт потоком с диска) */
async function api(method: string, path: string, body?: unknown): Promise<Res> {
  const out: Res = { status: 0, headers: {}, body: Buffer.alloc(0), json: () => JSON.parse(out.body.toString('utf8')) };
  const res = Object.assign(new PassThrough(), {
    headersSent: false,
    writeHead(code: number, h: Record<string, string> = {}) {
      out.status = code;
      for (const [k, v] of Object.entries(h)) out.headers[k.toLowerCase()] = String(v);
      res.headersSent = true;
      return res;
    },
  });
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise((r) => res.on('end', r));
  try {
    await handleTasks(fakeReq(method, path, body), res as unknown as ServerResponse, new URL(path, 'http://x'));
    await done;
    out.body = Buffer.concat(chunks);
  } catch (e) {
    const err = e as { status?: number; message: string };
    out.status = err.status ?? 500;
    out.body = Buffer.from(JSON.stringify({ error: err.message }));
  }
  return out;
}

const dir = mkdtempSync(join(tmpdir(), 'tasks-test-'));
setTasksDir(dir);
const ME = { by: 'Григорий' };
const AGENT = { by: 'Claude', agent: true };
const board = async () => (await api('GET', '/api/tasks')).json() as { rev: string; tasks: Task[]; people: string[] };
const col = async (s: Task['status']) => columnTasks((await board()).tasks, s).map((t) => t.id);

console.log('Доска задач');

await test('пустая доска', async () => {
  const b = await board();
  assert.deepEqual(b.tasks, []);
  assert.match(b.rev, /^[0-9a-f]{8}\.0$/);
});

await test('создание: номер по порядку, по умолчанию «Бэклог», «Доработка», «Обычный»', async () => {
  const r = await api('POST', '/api/tasks', { title: '  Кнопка   «Задачи» в шапке ', description: 'Описание\r\nв две строки', ...ME });
  assert.equal(r.status, 201, r.body.toString());
  const t = r.json() as Task;
  assert.equal(t.id, 1);
  assert.equal(t.title, 'Кнопка «Задачи» в шапке');
  assert.equal(t.description, 'Описание\nв две строки');
  assert.equal(t.status, 'backlog');
  assert.equal(t.kind, 'improvement');
  assert.equal(t.priority, 'normal');
  assert.equal(t.author, 'Григорий');
  assert.equal(t.events.length, 1);
  assert.ok(existsSync(join(dir, 'tasks.json')));
});

await test('без имени и без заголовка — 400', async () => {
  assert.equal((await api('POST', '/api/tasks', { title: 'x' })).status, 400);
  assert.equal((await api('POST', '/api/tasks', { title: '   ', ...ME })).status, 400);
  assert.equal((await api('POST', '/api/tasks', { title: 'x', status: 'nope', ...ME })).status, 400);
  assert.equal((await api('POST', '/api/tasks', { title: 'x', kind: 'epic', ...ME })).status, 400);
});

await test('новые задачи — в конец колонки; ревизия растёт; та же ревизия — unchanged', async () => {
  for (const title of ['Вторая', 'Третья', 'Четвёртая']) assert.equal((await api('POST', '/api/tasks', { title, status: 'todo', ...ME })).status, 201);
  assert.deepEqual(await col('todo'), [2, 3, 4]);
  const b = await board();
  assert.ok(b.rev.endsWith('.4'));
  const same = (await api('GET', `/api/tasks?rev=${b.rev}`)).json();
  assert.deepEqual(same, { rev: b.rev, unchanged: true });
  assert.ok((await api('GET', `/api/tasks?rev=${b.rev.replace(/\.4$/, '.3')}`)).json().tasks);
  // ревизия прежнего запуска сервера (другая метка) — полная доска, даже если номер совпал
  assert.ok((await api('GET', `/api/tasks?rev=deadbeef.4`)).json().tasks);
});

await test('перенос внутри колонки и между колонками по индексу', async () => {
  let r = await api('PATCH', '/api/tasks/4', { index: 0, ...ME });
  assert.equal(r.status, 200, r.body.toString());
  assert.deepEqual(await col('todo'), [4, 2, 3]);
  r = await api('PATCH', '/api/tasks/1', { status: 'todo', index: 1, ...ME });
  assert.deepEqual(await col('todo'), [4, 1, 2, 3]);
  assert.deepEqual(await col('backlog'), []);
  const t = r.json() as Task;
  assert.equal(t.events.at(-1)!.text, 'Колонка: Бэклог → К работе');
  // индекс за краем — в конец; без индекса — в конец
  await api('PATCH', '/api/tasks/4', { status: 'review', index: 99, ...ME });
  await api('PATCH', '/api/tasks/2', { status: 'review', ...ME });
  assert.deepEqual(await col('review'), [4, 2]);
  assert.deepEqual(await col('todo'), [1, 3]);
});

await test('перенос по соседу (before): встаёт перед ним, где бы тот ни оказался; соседа нет — в конец', async () => {
  // доска: todo [1, 3], review [4, 2]
  let r = await api('PATCH', '/api/tasks/2', { status: 'todo', before: 3, ...ME });
  assert.equal(r.status, 200);
  assert.deepEqual(await col('todo'), [1, 2, 3]);
  r = await api('PATCH', '/api/tasks/3', { before: 1, ...ME });
  assert.deepEqual(await col('todo'), [3, 1, 2]);
  r = await api('PATCH', '/api/tasks/3', { before: null, ...ME });
  assert.deepEqual(await col('todo'), [1, 2, 3]);
  r = await api('PATCH', '/api/tasks/2', { status: 'review', before: 999, ...ME });
  assert.deepEqual(await col('review'), [4, 2]);
  assert.deepEqual(await col('todo'), [1, 3]);
});

await test('expect: взять можно, только если задачу ещё никто не взял (двое агентов — один получает 409)', async () => {
  const a = await api('PATCH', '/api/tasks/3', { status: 'doing', assignee: 'Агент 1', expect: { status: 'todo', assignee: null }, ...AGENT });
  assert.equal(a.status, 200, a.body.toString());
  const b = await api('PATCH', '/api/tasks/3', { status: 'doing', assignee: 'Агент 2', expect: { status: 'todo', assignee: null }, ...AGENT });
  assert.equal(b.status, 409);
  assert.equal(b.json().task.assignee, 'Агент 1');
  assert.match(b.json().error, /уже изменили/);
  await api('PATCH', '/api/tasks/3', { status: 'todo', assignee: null, ...ME });
  assert.deepEqual(await col('todo'), [1, 3]);
});

await test('«В работе» без исполнителя — исполнитель тот, кто перенёс', async () => {
  const t = (await api('PATCH', '/api/tasks/3', { status: 'doing', ...AGENT })).json() as Task;
  assert.equal(t.assignee, 'Claude');
  assert.equal(t.events.at(-1)!.agent, true);
  assert.ok(t.events.some((e) => e.text === 'Исполнитель: Claude'));
  const back = (await api('PATCH', '/api/tasks/3', { status: 'todo', assignee: null, ...ME })).json() as Task;
  assert.equal(back.assignee, null);
});

await test('пустая правка не меняет ни версию, ни ревизию', async () => {
  const before = await board();
  const t1 = before.tasks.find((t) => t.id === 1)!;
  const r = (await api('PATCH', '/api/tasks/1', { title: t1.title, priority: t1.priority, ...ME })).json() as Task;
  assert.equal(r.version, t1.version);
  assert.equal((await board()).rev, before.rev);
});

await test('правка текста: чужая правка с той же базы — 409 со свежей задачей', async () => {
  const t = (await api('GET', '/api/tasks/1')).json() as Task;
  const base = { title: t.title, description: t.description };
  const a = await api('PATCH', '/api/tasks/1', { description: 'Версия Анны', base, by: 'Анна' });
  assert.equal(a.status, 200);
  // перенос другим человеком текст не трогает — правка текста с прежней базы всё равно конфликтует только по тексту
  const b = await api('PATCH', '/api/tasks/1', { description: 'Версия Григория', base, ...ME });
  assert.equal(b.status, 409);
  assert.equal(b.json().task.description, 'Версия Анны');
  // перенос с устаревшей базой текста, но без правки текста — проходит
  const c = await api('PATCH', '/api/tasks/1', { priority: 'high', base, ...ME });
  assert.equal(c.status, 200);
  assert.equal(c.json().priority, 'high');
});

await test('вопрос агента: флаг ставится, ответ человека его снимает; next пропускает такие задачи', async () => {
  let t = (await api('POST', '/api/tasks/1/comments', { text: 'Какой формат у отчёта?', question: true, ...AGENT })).json() as Task;
  assert.equal(t.question, true);
  assert.equal(t.comments.at(-1)!.agent, true);
  assert.equal(nextTask((await board()).tasks)?.id, 3);
  t = (await api('POST', '/api/tasks/1/comments', { text: 'PDF, как КП', ...ME })).json() as Task;
  assert.equal(t.question, undefined);
  // вопрос от человека флаг не ставит
  t = (await api('POST', '/api/tasks/1/comments', { text: 'ещё?', question: true, ...ME })).json() as Task;
  assert.equal(t.question, undefined);
  assert.equal(nextTask((await board()).tasks)?.id, 1, 'высокий приоритет раньше обычного');
});

await test('удалить комментарий', async () => {
  const t = (await api('GET', '/api/tasks/1')).json() as Task;
  const cid = t.comments[0].id;
  assert.equal((await api('DELETE', `/api/tasks/1/comments/${cid}`)).status, 400, 'без имени нельзя');
  const r = await api('DELETE', `/api/tasks/1/comments/${cid}?by=${encodeURIComponent('Григорий')}`);
  assert.equal(r.status, 200);
  assert.equal(r.json().comments.length, t.comments.length - 1);
  assert.equal((await api('DELETE', `/api/tasks/1/comments/${cid}?by=x`)).status, 404);
});

await test('люди: недавние первыми, без агентов', async () => {
  const b = await board();
  assert.deepEqual(new Set(b.people), new Set(['Григорий', 'Анна']));
  assert.equal(peopleOf([]).length, 0);
});

await test('вложения: тип по содержимому, отдача, выдача на скачивание, удаление', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  let r = await api('POST', `/api/tasks/2/files?name=${encodeURIComponent('скрин экрана.png')}&by=${encodeURIComponent('Анна')}`, png);
  assert.equal(r.status, 201, r.body.toString());
  const f = (r.json() as Task).files[0];
  assert.equal(f.type, 'image/png');
  assert.equal(f.size, png.length);
  r = await api('GET', `/api/tasks/2/files/${f.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'image/png');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.ok(r.headers['content-disposition'].startsWith('inline;'));
  assert.ok(r.body.equals(png));
  assert.ok((await api('GET', `/api/tasks/2/files/${f.id}?download=1`)).headers['content-disposition'].startsWith('attachment;'));
  // HTML под видом картинки — отдаётся только на скачивание, не показывается в браузере
  r = await api('POST', `/api/tasks/2/files?name=evil.png&by=x`, Buffer.from('<script>alert(1)</script>'));
  const evil = (r.json() as Task).files[1];
  assert.equal(evil.type, 'application/octet-stream');
  const g = await api('GET', `/api/tasks/2/files/${evil.id}`);
  assert.equal(g.headers['content-type'], 'application/octet-stream');
  assert.ok(g.headers['content-disposition'].startsWith('attachment;'));
  assert.equal((await api('POST', `/api/tasks/2/files?name=x&by=x`, Buffer.alloc(0))).status, 400);
  r = await api('DELETE', `/api/tasks/2/files/${evil.id}?by=x`);
  assert.equal(r.json().files.length, 1);
  assert.equal(readdirSync(join(dir, 'task-files', '2')).length, 1);
});

await test('sniffType: PDF, JPEG, текст DXF, двоичный DXF', () => {
  assert.equal(sniffType(Buffer.from('%PDF-1.7\n'), 'a.pdf'), 'application/pdf');
  assert.equal(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'a.jpg'), 'image/jpeg');
  assert.equal(sniffType(Buffer.from('0\nSECTION\n'), 'part.DXF'), 'text/plain');
  assert.equal(sniffType(Buffer.from([0x41, 0, 0x42]), 'part.dxf'), 'application/octet-stream');
});

await test('удаление задачи — вместе с вложениями; номер не переиспользуется', async () => {
  const r = await api('DELETE', `/api/tasks/2?by=${encodeURIComponent('Анна')}`);
  assert.equal(r.status, 200);
  assert.equal(r.json().id, 2);
  assert.ok(!existsSync(join(dir, 'task-files', '2')));
  assert.equal((await api('GET', '/api/tasks/2')).status, 404);
  assert.equal((await api('POST', '/api/tasks', { title: 'Пятая', ...ME })).json().id, 5);
});

await test('после перезапуска (с диска) — то же самое; есть копия за день', async () => {
  const before = await board();
  setTasksDir(dir);
  const after = await board();
  assert.deepEqual(after, before);
  assert.equal(JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8')).seq, 5);
  assert.equal(readdirSync(join(dir, 'tasks-backups')).length, 1);
});

await test('неизвестный адрес и метод', async () => {
  assert.equal((await api('GET', '/api/tasks/abc')).status, 404);
  assert.equal((await api('PUT', '/api/tasks/1')).status, 405);
  assert.equal((await api('DELETE', '/api/tasks')).status, 405);
});

await test('Markdown задачи для агента и slug ветки', async () => {
  const t = (await api('GET', '/api/tasks/1')).json() as Task;
  const md = taskMarkdown(t, { url: 'https://x/tasks?task=1' });
  assert.ok(md.startsWith('# #1 Кнопка «Задачи» в шапке\n'));
  assert.ok(md.includes('- Колонка: К работе (`todo`)'));
  assert.ok(md.includes('## Комментарии'));
  assert.ok(md.includes('(ИИ-агент)') || t.comments.every((c) => !c.agent));
  assert.equal(slug('Ошибка в PDF: «гибы» не видны!'), 'oshibka-v-pdf-giby-ne-vidny');
  assert.equal(slug('!!!'), 'task');
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} прошло${failed.length ? `, ${failed.length} упало: ${failed.join('; ')}` : ''}`);
if (failed.length) process.exit(1);
