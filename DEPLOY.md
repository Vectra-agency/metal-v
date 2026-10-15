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

## Заметки

- «Обновить цены» в интерфейсе ходит на mc.ru с адреса сервера. nginx пускает на
  `/api/prices/refresh` не чаще 3 раз в минуту с одного IP, чтобы mc.ru не заблокировал сервер.
- Сайт открыт всем, у кого есть ссылка; входа по паролю нет.
- Контейнер ограничен 256 МБ памяти, логи — 3 × 10 МБ.
