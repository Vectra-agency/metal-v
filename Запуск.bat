@echo off
rem Запуск калькулятора (Windows): двойной щелчок
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Не найден Node.js. Установите с https://nodejs.org ^(23.6+^) & pause & exit /b 1)
if not exist node_modules call npm install
call npm run build || (pause & exit /b 1)
start "" http://localhost:8787
npm start
