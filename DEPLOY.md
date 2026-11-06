# Деплой

Прод: **https://metal.vectra-agency.tech** — VPS 185.185.142.128 (общий с другими проектами Vectra).

| | |
|---|---|
| Каталог | `/var/www/metal-v` — git-клон этого репозитория |
| Runtime | docker compose, сервис `app`, образ `metal-v:latest` |
| Порт | `127.0.0.1:61890` → контейнер `8787`; снаружи только через nginx |
| Цены mc.ru | `/var/www/metal-v/data/prices.json` (монтируется в контейнер, переживает пересборку) |
| nginx | `/etc/nginx/sites-available/metal-v` = [ops/nginx/metal.conf](ops/nginx/metal.conf) |
| TLS | Let's Encrypt, `certbot.timer` продлевает сам |
| Проверка | `curl https://metal.vectra-agency.tech/api/health` → `{"ok":true,"version":"<sha>"}` |
| ИИ-анализ | ключ PoYo (`POYO_API_KEY`) — в `/var/www/metal-v/.env` (см. [ИИ-анализ](#ии-анализ)), проверка — `/api/ai/status` |

## Автодеплой (GitHub Actions)

[.github/workflows/deploy.yml](.github/workflows/deploy.yml): на каждый push и PR — `npm ci` + `npm run build`
(проверка типов и сборка). На push в `main` дополнительно:

1. по SSH на сервере `git fetch` + `git checkout <sha>`;
2. `ops/deploy.sh <sha>` — пересборка образа, перезапуск, ожидание `/api/health` с этим sha;
   если новая версия не поднялась — возврат предыдущего образа, job красный;
3. проверка, что `https://metal.vectra-agency.tech/api/health` отдаёт новый sha.

Секреты репозитория (Settings → Secrets and variables → Actions → *Repository secrets*):

| Секрет | Значение |
|---|---|
| `DEPLOY_HOST` | `185.185.142.128` |
| `DEPLOY_USER` | `root` |
| `DEPLOY_SSH_KEY` | приватный ключ целиком, от `-----BEGIN OPENSSH PRIVATE KEY-----` до `-----END …-----` |
| `DEPLOY_PORT` | необязательно, по умолчанию 22 |

Публичная часть ключа лежит в `/root/.ssh/authorized_keys` на сервере с комментарием
`github-actions@metal-v`. Отозвать доступ CI — удалить эту строку.

Пока секретов нет, деплой пропускается с предупреждением, сборка всё равно проверяется.
Перезапустить деплой вручную: Actions → CI/CD → Run workflow.

Сервер забирает код по HTTPS без ключа, потому что репозиторий публичный. Если сделать его
приватным, нужен deploy key: `ssh-keygen -t ed25519 -f ~/.ssh/metal-v` на сервере,
публичную часть — в Settings → Deploy keys, remote — `git@github.com:Vectra-agency/metal-v.git`
с `core.sshCommand "ssh -i ~/.ssh/metal-v"`.

## Вручную на сервере

```bash
cd /var/www/metal-v
git fetch && git checkout --detach origin/main && ./ops/deploy.sh   # обновить до main
docker compose logs -f app                                          # логи
docker compose restart app                                          # перезапуск без сборки
```

## Первичная установка (уже сделана, для переезда на другой сервер)

```bash
git clone https://github.com/Vectra-agency/metal-v.git /var/www/metal-v
cd /var/www/metal-v && ./ops/deploy.sh
# по желанию — свежие цены с рабочей машины: scp data/prices.json root@<host>:/var/www/metal-v/data/

# nginx: сначала временный http-vhost для проверки certbot, затем боевой конфиг
certbot certonly --nginx -d metal.vectra-agency.tech
cp ops/nginx/metal.conf /etc/nginx/sites-available/metal-v
ln -s /etc/nginx/sites-available/metal-v /etc/nginx/sites-enabled/metal-v
nginx -t && systemctl reload nginx
```

## ИИ-анализ

Сервер передаёт данные заказа модели через [PoYo AI](https://poyo.ai) (как video-creator):
[server/llm.ts](server/llm.ts) — запросы к модели, [server/ai.ts](server/ai.ts) — очередь задач и проверки,
[server/prompts/analyze.md](server/prompts/analyze.md) — промпт. Без ключа калькулятор работает как раньше,
шаг «Анализ ИИ» пропускается.

Модели (по умолчанию, меняются через `.env`):

| | Модель | Запрос | Цена за 1 млн токенов (ввод / вывод) |
|---|---|---|---|
| основная | `claude-haiku-5-5` | `POST /v1/messages` (Anthropic Messages): строгая JSON-схема, изображения чертежей | $0,08 / $0,40 |
| резервная | `gemini-3.8-flash` | `POST /v1/chat/completions` | $0,60 / $3,00 |

Если основная не ответила (сбой, перегрузка, тайм-аут, модель снята), сервер сам отправляет запрос резервной — другой
поставщик, поэтому общий сбой Anthropic её не задевает. На неверный ключ и пустой баланс резерв не тратится — сразу ошибка.

Включить:

1. Ключ PoYo — https://poyo.ai/dashboard/api-key (тот же, что у video-creator, или отдельный).
2. На сервере:
   ```bash
   cd /var/www/metal-v
   printf 'POYO_API_KEY=%s\n' 'pk-…' > .env && chmod 600 .env   # или cp .env.example .env и вписать ключ
   docker compose up -d                                          # контейнер пересоздаётся с переменными из .env
   ```
   `.env` в `.gitignore` и `.dockerignore`: деплой (`git checkout` + `ops/deploy.sh`) его не трогает, в образ он не попадает —
   docker compose передаёт переменные через `environment:` в [docker-compose.yml](docker-compose.yml).
3. Проверить: `curl https://metal.vectra-agency.tech/api/ai/status` →
   `{"configured":true,"model":"claude-haiku-5-5","vision":true}`; при старте в `docker compose logs app`
   есть строка «ИИ-анализ: …» (без ключа).
4. nginx: из [ops/nginx/metal.conf](ops/nginx/metal.conf) перенести зону `metal_ai` и `location = /api/ai/jobs`,
   затем `nginx -t && systemctl reload nginx` — деплой конфиг nginx не обновляет.

Другой сервис вместо PoYo (Hubris, OpenAI) — переменными `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_FALLBACK_MODELS`
(см. [.env.example](.env.example)); явный `LLM_BASE_URL` важнее `POYO_API_KEY`.

Как устроено: браузер создаёт задачу `POST /api/ai/jobs` (данные заказа до 900 КБ), догружает изображения чертежей
`PUT /api/ai/jobs/<id>/images/<n>` (JPEG до 900 КБ) и раз в ~1,5 с опрашивает `GET /api/ai/jobs/<id>`; отмена —
`DELETE`. Ответ модели идёт 20–70 с, поэтому запрос к ней — фоновый и не упирается в `proxy_read_timeout` nginx (60 с).
Задачи и изображения живут только в памяти: перезапуск контейнера обрывает идущие анализы (браузер покажет ошибку,
расчёт без ИИ остаётся). Деньги модель не считает — она проверяет входные данные и предлагает правки, расчёт делает код.
Правки: материал, толщина, количество, гибы, доп. операции и «исключить из расчёта» (незаказанное базовое исполнение
чертежа, дубль файла) — последнее никогда не применяется само, решает менеджер. В ответе (`AiAnalysis`) сервер пишет
расход `usage` (токены и стоимость в $ по ценам каталога PoYo) и `fallback` — ответила резервная модель, а не основная;
интерфейс показывает стоимость анализа и пометку «резервная модель».

Ограничения: 2 запроса к модели одновременно, очередь до 6 задач (иначе 429 «Сервер ИИ занят»), 20 задач в час с
одного адреса (сервер, по `X-Real-IP` от nginx), 6 новых задач в минуту с адреса (nginx), результат хранится 30 минут.

Стоимость (проверено на `scripts/fixtures/context-p4.json`, 7 позиций с заявкой, ≈ 20 тыс. входных и 5–9 тыс. выходных
токенов): основная модель ≈ $0,004–0,005 (25–45 с, с изображением чертежа — до ≈ 70 с), резервная ≈ $0,02 (≈ 30 с).
Расход и баланс — в кабинете PoYo (1 кредит = $0,005).

Лог — одна строка на задачу, без ключа и без данных заказа:
`[ai] 4970cd94 готово за 26177 мс · позиций 7 · изображений 0 · claude-haiku-5-5 · токены 20317+4937 ≈ $0.0036 · с замечаниями 4`;
если ответила резервная модель — после её имени « (резервная модель)», а строкой выше
`[llm] claude-haiku-5-5 не ответила (…) — пробуем резервную модель gemini-3.8-flash`; прочие ошибки — строками `[llm] …`.

| Симптом | Что делать |
|---|---|
| `configured:false` | в контейнере нет ключа: проверить `/var/www/metal-v/.env` (`POYO_API_KEY`), `docker compose up -d` |
| «Ключ ИИ отклонён сервисом (401)» | ключ отозван или с опечаткой — новый на https://poyo.ai/dashboard/api-key |
| «На балансе сервиса ИИ не хватает денег (402)» | пополнить кредиты PoYo |
| «Модель ИИ не найдена» | модель сняли — заменить `LLM_MODEL` / `LLM_FALLBACK_MODELS` (список: https://docs.poyo.ai/api-manual/chat-series/overview) |
| «Сервер ИИ занят» | идут 2 анализа и 6 ждут — повторить через минуту |
| В карточке ИИ «резервная модель» | основная не ответила — причина в логе (`[llm] … не ответила`); анализ полноценный, повторять не обязательно |

Промпт читается при каждом анализе: правка `server/prompts/analyze.md` — через git и обычный деплой.
Проверка на машине разработчика: `node scripts/test-ai.ts` (офлайн, без ключа), `node scripts/ai-smoke.ts`
(настоящий запрос к модели по `scripts/fixtures/context-p4.json`, ≈ $0,005; `LLM_MODEL=нет-такой node scripts/ai-smoke.ts` —
проверка резервной модели).

## Заметки

- Базовый образ `node:26-alpine`: Docker Hub ограничивает анонимные скачивания по IP (`429 Too Many
  Requests`), а сервер общий. `ops/deploy.sh` перед сборкой берёт образ из локального кэша, иначе
  скачивает с Docker Hub (с повтором), иначе с зеркал `mirror.gcr.io` / `dockerhub.timeweb.cloud` и
  тегает исходным именем — сборка в реестр не ходит. Если другие проекты чистят образы
  (`docker image prune -a`), образ просто скачается заново.
- «Обновить цены» в интерфейсе ходит на mc.ru с адреса сервера. nginx пускает на
  `/api/prices/refresh` не чаще 3 раз в минуту с одного IP, чтобы mc.ru не заблокировал сервер.
- Сайт открыт всем, у кого есть ссылка; входа по паролю нет.
- Контейнер ограничен 256 МБ памяти, логи — 3 × 10 МБ.
