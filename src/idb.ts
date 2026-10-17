// Хранение исходных PDF в браузере (IndexedDB), чтобы чертёж можно было
// открыть после перезагрузки. Ошибки не критичны: без файла просто нет картинки.

const DB = 'metalcalc';
const STORE = 'files';

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

/** Сохранить файл; false — не сохранён (приватный режим, нет IndexedDB, нет места) */
export async function putFile(key: string, data: ArrayBuffer): Promise<boolean> {
  try {
    const db = await open();
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(data, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
    return true;
  } catch {
    /* приватный режим и т.п. — работаем без сохранения */
    return false;
  }
}

export async function getFile(key: string): Promise<ArrayBuffer | null> {
  try {
    const db = await open();
    const v = await new Promise<ArrayBuffer | null>((res, rej) => {
      const r = db.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => res((r.result as ArrayBuffer) ?? null);
      r.onerror = () => rej(r.error);
    });
    db.close();
    return v;
  } catch {
    return null;
  }
}

/** Есть ли файл (без чтения содержимого); null — хранилище недоступно, неизвестно */
export async function hasFile(key: string): Promise<boolean | null> {
  try {
    const db = await open();
    const n = await new Promise<number>((res, rej) => {
      const r = db.transaction(STORE).objectStore(STORE).count(key);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    db.close();
    return n > 0;
  } catch {
    return null;
  }
}

/** Ключи всех сохранённых файлов; ошибка — пустой список */
export async function listFileKeys(): Promise<string[]> {
  try {
    const db = await open();
    const keys = await new Promise<string[]>((res, rej) => {
      const r = db.transaction(STORE).objectStore(STORE).getAllKeys();
      r.onsuccess = () => res((r.result as IDBValidKey[]).filter((k): k is string => typeof k === 'string'));
      r.onerror = () => rej(r.error);
    });
    db.close();
    return keys;
  } catch {
    return [];
  }
}

export async function deleteFiles(keys: string[]): Promise<void> {
  if (!keys.length) return;
  try {
    const db = await open();
    await new Promise<void>((res) => {
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      for (const k of keys) st.delete(k);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
    db.close();
  } catch {
    /* игнор */
  }
}

/** Удаляет файлы, на которые никто не ссылается (keep — нужные ключи); возвращает, сколько удалено */
export async function sweepFiles(keep: Iterable<string>): Promise<number> {
  try {
    const need = new Set(keep);
    const drop = (await listFileKeys()).filter((k) => !need.has(k));
    await deleteFiles(drop);
    return drop.length;
  } catch {
    return 0;
  }
}

export async function clearFiles(): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((res) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
    db.close();
  } catch {
    /* игнор */
  }
}

// ---------- файлы, которые ещё может вернуть «Вернуть» ----------

const holds = new Map<string, number>(); // ключ → сколько живых снимков на него ссылается

/** Не удалять эти файлы, пока жив снимок отмены (уведомление с «Вернуть»); вызов результата — отпустить (один раз) */
export function holdFiles(keys: Iterable<string>): () => void {
  const list = [...new Set(keys)];
  for (const k of list) holds.set(k, (holds.get(k) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const k of list) {
      const n = (holds.get(k) ?? 0) - 1;
      if (n > 0) holds.set(k, n);
      else holds.delete(k);
    }
  };
}

/** Ключи, удерживаемые живыми снимками отмены */
export const heldFileKeys = (): Set<string> => new Set(holds.keys());

// ---------- другие вкладки ----------

const TAB_LOCK = 'metalcalc:tab';
const LOCK_WAIT_MS = 2000;
let tabLock: Promise<boolean> | null = null; // true — замок вкладки взят; false — Web Locks нет

/** Вкладка держит общий замок всю жизнь: по числу держателей видно, открыто ли приложение где-то ещё (не ждём) */
export function holdTabLock(): void {
  if (tabLock) return;
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) {
    tabLock = Promise.resolve(false);
    return;
  }
  tabLock = new Promise<boolean>((res) => {
    locks
      .request(TAB_LOCK, { mode: 'shared' }, () => {
        res(true);
        return new Promise<void>(() => {}); // до закрытия вкладки
      })
      .catch(() => res(false));
  });
}

/** Открыта ли ещё вкладка с приложением: её заказ может ссылаться на файлы. Без Web Locks — false (как раньше) */
export async function otherTabsAlive(): Promise<boolean> {
  holdTabLock();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const held = await Promise.race([tabLock!, new Promise<null>((r) => (timer = setTimeout(() => r(null), LOCK_WAIT_MS)))]);
  clearTimeout(timer);
  if (held === false) return false;
  if (held === null) return true; // замок не дали — не знаем, удалять не будем
  try {
    const q = await navigator.locks.query();
    const mine = (l: LockInfo) => l.name === TAB_LOCK;
    return (q.held ?? []).filter(mine).length + (q.pending ?? []).filter(mine).length > 1;
  } catch {
    return true;
  }
}
