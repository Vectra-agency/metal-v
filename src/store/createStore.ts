// Хранилище состояния без зависимостей: одно неизменяемое значение, подписчики, селекторы через useSyncExternalStore.
import { useSyncExternalStore } from 'react';

export interface Store<S> {
  get(): S;
  set(fn: (s: S) => S): void;
  subscribe(l: () => void): () => void;
}

export function createStore<S>(initial: S): Store<S> {
  let state = initial;
  const ls = new Set<() => void>();
  return {
    get: () => state,
    set(fn) {
      const next = fn(state);
      if (Object.is(next, state)) return;
      state = next;
      for (const l of [...ls]) l();
    },
    subscribe(l) {
      ls.add(l);
      return () => {
        ls.delete(l);
      };
    },
  };
}

/** Селектор ОБЯЗАН возвращать примитив или уже существующую ссылку (не новый объект/массив) — иначе бесконечный цикл */
export function useSelector<S, T>(store: Store<S>, sel: (s: S) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => sel(store.get()),
    () => sel(store.get()),
  );
}
