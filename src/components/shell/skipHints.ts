// Подсказки для журнала загрузки о пропущенных файлах: что это за файл и что с ним сделать (ui-spec §4.6.1).
// Чистые функции: вход — список файлов, выход — записи журнала уровня warn и число пропущенных.
import { plural } from '@/format.ts';

const RE_READ = /\.(dxf|pdf|txt)$/i;
/** Сколько отдельных записей на одну группу «по файлу» — дальше одной строкой «… и ещё N» */
const PER_GROUP = 8;

const KOMPAS = new Set(['m3d', 'a3d', 'cdw', 'frw']);
const DWG = new Set(['dwg']);
const OFFICE = new Set(['xls', 'xlsx', 'doc', 'docx', 'rtf', 'odt']);
const IMAGE = new Set(['jpg', 'jpeg', 'png', 'tif', 'tiff', 'bmp', 'heic']);
const MODEL3D = new Set(['step', 'stp', 'igs', 'iges', 'sldprt', 'x_t']);
const ARCHIVE = new Set(['zip', 'rar', '7z']);

export interface SkipHint {
  level: 'warn';
  text: string;
}

/** Служебные файлы системы и офиса (.DS_Store, ~$заявка.docx, Thumbs.db): не показываем и не считаем */
export function isJunkFile(name: string): boolean {
  const n = name.trim();
  return !n || n.startsWith('.') || n.startsWith('~$') || /^(thumbs\.db|desktop\.ini|icon\r?)$/i.test(n);
}

const extOf = (name: string) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};

const files = (n: number) => `${n} ${plural(n, 'файл', 'файла', 'файлов')}`;
const skippedVerb = (n: number) => plural(n, 'Пропущен', 'Пропущено', 'Пропущено');

/** Записи журнала о файлах, которые не будут прочитаны; count — сколько таких файлов */
export function skipHints(list: readonly File[] | readonly { name: string }[]): { entries: SkipHint[]; count: number } {
  const byExt = new Map<string, number>(); // КОМПАС-3D и DWG — одной строкой на расширение
  const perFile: { key: string; text: string }[] = [];
  let count = 0;
  for (const f of list) {
    if (isJunkFile(f.name) || RE_READ.test(f.name)) continue;
    count++;
    const ext = extOf(f.name);
    const name = f.name;
    if (KOMPAS.has(ext) || DWG.has(ext)) byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
    else if (OFFICE.has(ext)) perFile.push({ key: 'office', text: `${name} не читается — скопируйте текст заявки в поле «Заявка клиента»` });
    else if (IMAGE.has(ext)) perFile.push({ key: 'image', text: `${name} — картинка: пришлите чертёж в PDF или DXF` });
    else if (MODEL3D.has(ext)) perFile.push({ key: '3d', text: `${name} — 3D-модель: нужна развёртка в DXF` });
    else if (ARCHIVE.has(ext)) perFile.push({ key: 'archive', text: `Архив «${name}» не читается — распакуйте и перетащите папку` });
    else perFile.push({ key: 'other', text: `Пропущено: ${name} (не DXF, PDF или TXT)` });
  }
  const entries: SkipHint[] = [];
  for (const [ext, n] of byExt) {
    const tail = DWG.has(ext) ? '— сохраните как DXF' : '(КОМПАС-3D) — сохраните как DXF или PDF';
    entries.push({ level: 'warn', text: `${skippedVerb(n)} ${files(n)} .${ext} ${tail}` });
  }
  // по файлу, но не больше PER_GROUP строк на группу: сотня картинок не должна вытеснить журнал
  const groups = new Map<string, string[]>();
  for (const x of perFile) groups.set(x.key, [...(groups.get(x.key) ?? []), x.text]);
  for (const texts of groups.values()) {
    for (const text of texts.slice(0, PER_GROUP)) entries.push({ level: 'warn', text });
    const rest = texts.length - PER_GROUP;
    if (rest > 0) entries.push({ level: 'warn', text: `… и ещё ${files(rest)} того же типа` });
  }
  return { entries, count };
}
