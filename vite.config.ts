import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
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

export default defineConfig({
  base: './',
  plugins: [react(), api()],
  server: { port: 5173, open: false },
});
