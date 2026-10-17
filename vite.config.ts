import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Alias, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { handleApi } from './server/api.ts';

// API цен mc.ru прямо в dev-сервере — второй процесс не нужен
const api = (): Plugin => ({
  name: 'metal-calc-api',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (!(await handleApi(req, res))) next();
    });
  },
});

// Radix — одна копия каждого пакета @radix-ui/* на всё приложение. cmdk тянет свежие react-dialog и react-primitive,
// а radix-ui закрепляет точные версии, и npm кладёт копии внутрь пакетов. У каждой копии свой стек слоёв: всплывающее
// окно в диалоге не получает фокус и щелчки, Esc закрывает и сам диалог. Берём копию, закреплённую radix-ui, если она
// есть, иначе верхнюю — без правки зависимостей
function radixAliases(): Alias[] {
  const nm = fileURLToPath(new URL('./node_modules', import.meta.url));
  const top = join(nm, '@radix-ui');
  const pinned = join(nm, 'radix-ui', 'node_modules', '@radix-ui');
  if (!existsSync(top)) return [];
  return readdirSync(top, { withFileTypes: true })
    .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && /^[\w-]+$/.test(d.name))
    .map(({ name }) => ({
      find: new RegExp(`^@radix-ui/${name}$`),
      replacement: existsSync(join(pinned, name)) ? join(pinned, name) : join(top, name),
    }));
}

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), api()],
  resolve: {
    alias: [
      // @/… → src/… (как "paths" в tsconfig.json; так импортируют компоненты shadcn/ui)
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      ...radixAliases(),
    ],
  },
  server: { port: 5173, open: false },
});
