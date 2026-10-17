// Мемоизация по ссылкам аргументов с двумя ячейками: отложенная отрисовка (useDeferredValue) и getDerived()
// для действий считают по разным входам и не вытесняют друг друга.

const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

/** Кэш на 2 последних набора ключей: fn вызывается, только если такого набора ещё не было */
export function memoBy<A extends unknown[], R>(key: (...args: A) => readonly unknown[], fn: (...args: A) => R): (...args: A) => R {
  let k0: readonly unknown[] | null = null;
  let v0 = undefined as R;
  let k1: readonly unknown[] | null = null;
  let v1 = undefined as R;
  return (...args: A): R => {
    const k = key(...args);
    if (k0 && same(k0, k)) return v0;
    if (k1 && same(k1, k)) {
      // свежий — в первую ячейку
      [k0, v0, k1, v1] = [k1, v1, k0, v0];
      return v0;
    }
    const v = fn(...args);
    k1 = k0;
    v1 = v0;
    k0 = k;
    v0 = v;
    return v;
  };
}

/** Кэш на 2 последних набора аргументов (сравнение по Object.is) */
export function memo2<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return memoBy((...args: A) => args, fn);
}
