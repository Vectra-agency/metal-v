// Глобальные эффекты: старт (цены, статус ИИ, вход), горячие клавиши, вставка заявки, отмена анализа при закрытии
// вкладки, поиск деталей заказа в истории после каждого изменения позиций.
import { useEffect, type ReactElement } from 'react';
import { useDerived } from '@/store/derived.tsx';
import { loadAuthStatus, scheduleHistoryMatch } from '@/store/historyActions.ts';
import { abortOnPageHide, bootstrap } from '@/store/pipelineActions.ts';
import { useStore } from '@/store/store.ts';
import { usePasteCapture } from './usePasteCapture.ts';
import { useShortcuts } from './useShortcuts.ts';

export function GlobalEffects(): ReactElement | null {
  useEffect(() => {
    void bootstrap();
    void loadAuthStatus();
    // вкладку закрыли во время анализа — задачу на сервере снимаем (DELETE с keepalive)
    window.addEventListener('pagehide', abortOnPageHide);
    return () => window.removeEventListener('pagehide', abortOnPageHide);
  }, []);
  useShortcuts();
  usePasteCapture();
  useHistoryMatch();
  return null;
}

/** Та же деталь и похожие в прошлых заказах: позиции, расчёт (рез на шт), связь с историей или цены изменились */
function useHistoryMatch(): void {
  const d = useDerived();
  const live = useStore((s) => s.prices.live);
  const loaded = useStore((s) => s.prices.loaded);
  const linked = useStore((s) => s.order.history?.id);
  const version = useStore((s) => s.history.version);
  useEffect(() => {
    if (!loaded || !live || d.stale) return;
    scheduleHistoryMatch();
  }, [d.positions, d.res, d.stale, live, loaded, linked, version]);
}
