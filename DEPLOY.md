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
| ИИ-анализ | ключ шлюза — в `/var/www/metal-v/.env` (см. [ИИ-анализ](#ии-анализ)), проверка — `/api/ai/status` |

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

Сервер передаёт данные заказа модели через OpenAI-совместимый шлюз (рекомендуем [Hubris](https://hubris.pw)):
[server/llm.ts](server/llm.ts) — запросы к шлюзу, [server/ai.ts](server/ai.ts) — очередь задач и проверки,
[server/prompts/analyze.md](server/prompts/analyze.md) — промпт. Без настроек ИИ калькулятор работает как раньше,
шаг «Анализ ИИ» пропускается.

Включить:

1. На https://hubris.pw/keys завести отдельный ключ `metal-v` и поставить ему суточный лимит расходов
   (например, 100 ₽): сайт открыт без входа, лимит ключа — последняя защита бюджета.
2. На сервере:
   ```bash
   cd /var/www/metal-v
   cp .env.example .env && chmod 600 .env   # вписать LLM_API_KEY; шлюз, модель и резервные уже заполнены
   docker compose up -d                     # контейнер пересоздаётся с переменными из .env
   ```
   `.env` в `.gitignore` и `.dockerignore`: деплой (`git checkout` + `ops/deploy.sh`) его не трогает, в образ он не попадает —
   docker compose передаёт переменные через `environment:` в [docker-compose.yml](docker-compose.yml).
3. Проверить: `curl https://metal.vectra-agency.tech/api/ai/status` →
   `{"configured":true,"model":"anthropic/claude-haiku-5.5","vision":true}`; при старте в `docker compose logs app`
   есть строка «ИИ-анализ: …» (без ключа).
4. nginx: из [ops/nginx/metal.conf](ops/nginx/metal.conf) перенести зону `metal_ai` и `location = /api/ai/jobs`,
   затем `nginx -t && systemctl reload nginx` — деплой конфиг nginx не обновляет.

Как устроено: браузер создаёт задачу `POST /api/ai/jobs` (данные заказа до 900 КБ), догружает изображения чертежей
`PUT /api/ai/jobs/<id>/images/<n>` (JPEG до 900 КБ) и раз в ~1,5 с опрашивает `GET /api/ai/jobs/<id>`; отмена —
`DELETE`. Ответ модели идёт 10–60 с, поэтому запрос к ней — фоновый и не упирается в `proxy_read_timeout` nginx (60 с).
Задачи и изображения живут только в памяти: перезапуск контейнера обрывает идущие анализы (браузер покажет ошибку,
расчёт без ИИ остаётся). Деньги модель не считает — она проверяет входные данные и предлагает правки, расчёт делает код.
Правки: материал, толщина, количество, гибы, доп. операции и «исключить из расчёта» (незаказанное базовое исполнение
чертежа, дубль файла) — последнее никогда не применяется само, решает менеджер. В ответе (`AiAnalysis`) сервер пишет
расход `usage` (токены и ₽) и `fallback` — ответила резервная модель, а не `LLM_MODEL`; интерфейс показывает стоимость
анализа и пометку «резервная модель».

Ограничения: 2 запроса к модели одновременно, очередь до 6 задач (иначе 429 «Сервер ИИ занят»), 20 задач в час с
одного адреса (сервер, по `X-Real-IP` от nginx), 6 новых задач в минуту с адреса (nginx), результат хранится 30 минут.

Стоимость (Claude Haiku 5.5): заказ из 7 позиций с заявкой — ≈ 21 тыс. входных и 3 тыс. выходных токенов, ≈ 0,45 ₽
(10–13 с); из 3 позиций — ≈ 0,3 ₽; каждое изображение чертежа — ещё ≈ 2,5 тыс. токенов; большой заказ — до ≈ 2 ₽.
Расход и баланс — в кабинете Hubris.

Лог — одна строка на задачу, без ключа и без данных заказа:
`[ai] d40a4f0c готово за 12136 мс · позиций 7 · изображений 0 · anthropic/claude-haiku-5.5 · токены 21495+3054 ≈ 0.47 ₽ · с замечаниями 7`;
если ответила резервная модель — после её имени « (резервная модель)»; ответы шлюза с ошибкой — строками `[llm] …`
(код и текст ошибки).

| Симптом | Что делать |
|---|---|
| `configured:false` | в контейнере нет `LLM_*`: проверить `/var/www/metal-v/.env`, `docker compose up -d` |
| «Исчерпан лимит расходов ключа ИИ» | поднять лимит ключа `metal-v` или дождаться сброса (00:00 МСК) |
| «На балансе ИИ-шлюза не хватает денег» | пополнить баланс Hubris |
| «Модель ИИ не найдена» | модель сняли с каталога — заменить `LLM_MODEL` / `LLM_FALLBACK_MODELS` (https://hubris.pw/models) |
| `vision:false` | модель без зрения или справочник `GET /models` недоступен (повтор через минуту); можно `LLM_VISION=on` |
| «Сервер ИИ занят» | идут 2 анализа и 6 ждут — повторить через минуту |
| В карточке ИИ «резервная модель» | основная модель не ответила (перегружена или снята — `[llm] … не найдена` в логе); бесплатные резервные анализируют слабее: повторить анализ позже или заменить `LLM_MODEL` |

Промпт читается при каждом анализе: правка `server/prompts/analyze.md` — через git и обычный деплой.
Проверка на машине разработчика: `node scripts/test-ai.ts` (офлайн, без ключа), `node scripts/ai-smoke.ts`
(настоящий запрос к модели по `scripts/fixtures/context-p4.json`, ≈ 0,45 ₽).

## Заметки

- «Обновить цены» в интерфейсе ходит на mc.ru с адреса сервера. nginx пускает на
  `/api/prices/refresh` не чаще 3 раз в минуту с одного IP, чтобы mc.ru не заблокировал сервер.
- Сайт открыт всем, у кого есть ссылка; входа по паролю нет.
- Контейнер ограничен 256 МБ памяти, логи — 3 × 10 МБ.
