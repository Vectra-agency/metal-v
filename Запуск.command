#!/bin/bash
# Запуск калькулятора (macOS): двойной щелчок
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Не найден Node.js. Установите с https://nodejs.org (версия 23.6 или новее) и запустите снова."
  read -n 1 -s -r -p "Нажмите любую клавишу…"
  exit 1
fi
[ -d node_modules ] || npm install
npm run build || exit 1
(sleep 1.5 && open "http://localhost:8787") &
npm start
