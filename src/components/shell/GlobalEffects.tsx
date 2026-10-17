// Глобальные эффекты: старт (цены, статус ИИ), горячие клавиши, вставка заявки, отмена анализа при закрытии вкладки.
import { useEffect, type ReactElement } from 'react';
import { abortOnPageHide, bootstrap } from '@/store/pipelineActions.ts';
import { usePasteCapture } from './usePasteCapture.ts';
import { useShortcuts } from './useShortcuts.ts';

export function GlobalEffects(): ReactElement | null {
  useEffect(() => {
    void bootstrap();
    // вкладку закрыли во время анализа — задачу на сервере снимаем (DELETE с keepalive)
    window.addEventListener('pagehide', abortOnPageHide);
    return () => window.removeEventListener('pagehide', abortOnPageHide);
  }, []);
  useShortcuts();
  usePasteCapture();
  return null;
}
