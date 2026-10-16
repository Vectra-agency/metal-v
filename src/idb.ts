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

export async function putFile(key: string, data: ArrayBuffer): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(data, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  } catch {
    /* приватный режим и т.п. — работаем без сохранения */
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
