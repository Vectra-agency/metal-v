import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { toast } from 'sonner';
import { App } from './App.tsx';
import { Toaster } from '@/components/ui/sonner.tsx';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { initTheme } from '@/components/ui/theme.ts';
import { APP_UPDATED } from './pdfImport.ts';
import './index.css';
import './print.css';

initTheme();
// только в разработке: window.__metalcalcDev.fakeAi() — анализ ИИ без вызова модели
if (import.meta.env.DEV) void import('./ai/devFake.ts');

// после выкладки новой версии файлы старой (pdf.js и др.) в открытой вкладке не грузятся — предложить обновить.
// preventDefault не вызываем: ошибка доходит до места загрузки (там свой текст), уведомление одно
window.addEventListener('vite:preloadError', () => {
  toast.warning(APP_UPDATED, {
    id: 'app-updated',
    duration: Infinity,
    action: { label: 'Обновить', onClick: () => location.reload() },
  });
});

// вход истёк (30 дней) или пароль на сервере сменили: любой ответ API 401 с X-Auth-Required —
// предложить войти снова (заказ сохранён в браузере, после входа он на месте)
const nativeFetch = window.fetch.bind(window);
window.fetch = async (...args: Parameters<typeof fetch>) => {
  const r = await nativeFetch(...args);
  if (r.status === 401 && r.headers.get('X-Auth-Required')) {
    toast.error('Нужно войти снова', {
      id: 'auth-required',
      description: 'Срок входа истёк или пароль сменили. Заказ сохранён в браузере.',
      duration: Infinity,
      action: { label: 'Войти', onClick: () => location.reload() },
    });
  }
  return r;
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider delayDuration={300}>
      <App />
      {/* телефон: уведомления над нижней кнопкой «Скопировать для клиента» */}
      <Toaster position="bottom-right" visibleToasts={3} mobileOffset={{ bottom: 80 }} />
    </TooltipProvider>
  </StrictMode>,
);
