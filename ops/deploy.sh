#!/usr/bin/env bash
# Сборка и перезапуск на сервере: проверяет, что поднялась именно новая версия,
# иначе возвращает предыдущий образ.
#   ./ops/deploy.sh [sha]     # CI передаёт sha после git checkout
set -euo pipefail
cd "$(dirname "$0")/.."

export GIT_SHA="${1:-$(git rev-parse HEAD 2>/dev/null || echo dev)}"
IMAGE=metal-v:latest

# каталог цен монтируется в контейнер, где сервер работает от пользователя node (uid 1000)
mkdir -p data
chown 1000:1000 data 2>/dev/null || true

prev=$(docker image inspect "$IMAGE" --format '{{.Id}}' 2>/dev/null || true)

docker compose build
docker compose up -d --remove-orphans

for _ in $(seq 1 30); do
  if docker compose exec -T app wget -qO- http://127.0.0.1:8787/api/health 2>/dev/null | grep -q "\"version\":\"$GIT_SHA\""; then
    echo "Развёрнуто: $GIT_SHA"
    new=$(docker image inspect "$IMAGE" --format '{{.Id}}')
    if [ -n "$prev" ] && [ "$prev" != "$new" ]; then docker image rm "$prev" >/dev/null 2>&1 || true; fi
    exit 0
  fi
  sleep 2
done

echo "Новая версия не ответила на /api/health — откат" >&2
docker compose logs --tail 50 app >&2 || true
if [ -n "$prev" ]; then
  docker tag "$prev" "$IMAGE"
  docker compose up -d --no-build
fi
exit 1
