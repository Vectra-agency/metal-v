import { useCallback, useSyncExternalStore } from 'react';

/** Совпадает ли медиазапрос сейчас ('(min-width: 1280px)', '(pointer: coarse)'…); следит за изменениями */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const m = window.matchMedia(query);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
