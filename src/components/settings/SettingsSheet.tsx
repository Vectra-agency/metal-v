// «Расценки»: резка, гибка, материалы, раскрой и НДС, доп. операции, КП и цены.
// Правки применяются сразу; «Сбросить» — только расценки (настройки КП остаются), с «Вернуть»;
// файл расценок = { ...settings, quote } — туда и обратно, битый файл → уведомление (без системных окон).
import { useEffect, useMemo, useRef, type ChangeEvent, type ReactElement } from 'react';
import { Download, RotateCcw, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.tsx';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx';
import { isEditable } from '@/components/common/dom.ts';
import { MATERIAL_BY_ID, type SheetPolicy } from '@/core/materials.ts';
import { normalizeCutRows } from '@/core/cutPrice.ts';
import { DEFAULT_SETTINGS, type ExtraRate, type Settings } from '@/core/pricing.ts';
import { DEFAULT_QUOTE, type PieceRounding, type QuoteSettings } from '@/quote.ts';
import { closeSheet, openSheet, resetSettings, setQuoteSettings, setSettings } from '@/store/actions.ts';
import { getState, useStore } from '@/store/store.ts';
import type { SettingsTab } from '@/store/types.ts';
import { undoToast } from '@/store/undo.ts';
import { BendingTab } from './BendingTab.tsx';
import { CuttingTab } from './CuttingTab.tsx';
import { ExtraOpsTab } from './ExtraOpsTab.tsx';
import { MaterialsTab } from './MaterialsTab.tsx';
import { NestingTab } from './NestingTab.tsx';
import { QuoteSettingsTab } from './QuoteSettingsTab.tsx';
import { MAX_ROWS } from './shared.tsx';

const TABS: readonly [SettingsTab, string][] = [
  ['cut', 'Резка'],
  ['bend', 'Гибка'],
  ['mat', 'Материалы'],
  ['nest', 'Раскрой и НДС'],
  ['extra', 'Доп. операции'],
  ['quote', 'КП и цены'],
];

const FILE_NAME = 'расценки.json';
const READ_ERROR = 'Не удалось прочитать файл расценок';

// вкладка, на которой панель закрыли: открыть снова там же (и не мигать другой вкладкой при закрытии)
let lastTab: SettingsTab = 'cut';

const inToaster = (t: EventTarget | null) => t instanceof Element && !!t.closest('[data-sonner-toaster]');

// ---------- файл расценок ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
// название поля в уведомлении об ошибке — как в панели
const FIELD_NAME: Record<string, string> = {
  cutting: 'Резка',
  bending: 'Гибка',
  bendLenK: 'Множитель по длине гиба',
  bendSetup: 'Наладка листогиба на позицию',
  gap: 'Перемычка между деталями',
  margin: 'Поле по краю листа',
  bboxWastePct: 'Отход при списании «по габариту»',
  maxWastePct: 'Потолок отхода при раскрое',
  maxWasteWholePct: 'Потолок отхода «целыми листами»',
  markupPct: 'Наценка',
  vatPct: 'Ставка НДС',
  delivery: 'Доставка',
  priceMaxAgeHours: 'Обновлять цены mc.ru старше',
  policy: 'Списание металла',
  priceOverride: 'Цена металла, ₽/кг',
  sheetChoice: 'Выбор листа',
  matK: 'Множители материалов',
  extraRates: 'Доп. операции',
  quote: 'Настройки КП',
  'quote.rounding': 'Цена за шт в КП',
  'quote.validityDays': 'Цены действительны',
  'quote.header': 'Шапка КП',
  'quote.signature': 'Подпись',
  'quote.terms': 'Условия',
  'quote.showMaterial': 'Материал и толщина',
  'quote.showNotes': 'Примечания',
  'quote.showSketch': 'Эскизы деталей',
  'quote.amountInWords': 'Сумма прописью',
};
const bad = (key: string): never => {
  throw new Error(`Неверное поле: «${FIELD_NAME[key] ?? key}»`);
};

/** Таблица расценок: от 1 до 100 строк, числа ≥ 0, первое поле (толщина, длина) > 0 */
function numRows<T>(v: unknown, key: string, fields: readonly string[]): T[] {
  if (!Array.isArray(v) || !v.length || v.length > MAX_ROWS) return bad(key);
  return v.map((r) => {
    if (!isObj(r) || !fields.every((f) => isNum(r[f])) || !((r[fields[0]] as number) > 0)) return bad(key);
    return Object.fromEntries(fields.map((f) => [f, r[f]])) as T;
  });
}

function numMap(v: unknown, key: string): Record<string, number> {
  if (!isObj(v)) return bad(key);
  for (const x of Object.values(v)) if (!isNum(x)) bad(key);
  return { ...(v as Record<string, number>) };
}

const POLICIES: readonly SheetPolicy[] = ['length', 'whole', 'bbox'];
const ROUNDINGS: readonly PieceRounding[] = ['kop', 'rub', 'ten'];
const NUM_KEYS = [
  'bendSetup',
  'gap',
  'margin',
  'bboxWastePct',
  'maxWastePct',
  'maxWasteWholePct',
  'markupPct',
  'vatPct',
  'delivery',
  'priceMaxAgeHours',
] as const;

/** Разбор файла: известные поля проверяются по типам, отсутствующие берутся по умолчанию, лишние отбрасываются */
export function parseSettingsFile(text: string): { settings: Settings; quote: QuoteSettings | null } {
  let j: unknown;
  try {
    j = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new Error('Файл не в формате JSON');
  }
  if (!isObj(j)) throw new Error('В файле нет расценок');
  const known = Object.keys(DEFAULT_SETTINGS);
  if (!known.some((k) => k in j) && !('quote' in j)) throw new Error('В файле нет расценок');

  const s = structuredClone(DEFAULT_SETTINGS);
  // старые файлы (ставка ₽/м + врезка) — резка остаётся по прайсу
  if ('cutting' in j) s.cutting = normalizeCutRows(j.cutting, DEFAULT_SETTINGS.cutting) ?? s.cutting;
  if ('bending' in j) s.bending = numRows(j.bending, 'bending', ['t', 'perBend']);
  if ('bendLenK' in j) s.bendLenK = numRows(j.bendLenK, 'bendLenK', ['upTo', 'k']);
  for (const k of NUM_KEYS) {
    if (!(k in j)) continue;
    const v = j[k];
    if (!isNum(v)) bad(k);
    s[k] = v as number;
  }
  if ('policy' in j) {
    if (!isObj(j.policy)) bad('policy');
    const p: Record<string, SheetPolicy> = {};
    for (const [id, v] of Object.entries(j.policy as Obj)) {
      if (!POLICIES.includes(v as SheetPolicy)) bad('policy');
      if (MATERIAL_BY_ID.has(id)) p[id] = v as SheetPolicy;
    }
    s.policy = p;
  }
  if ('priceOverride' in j) s.priceOverride = numMap(j.priceOverride, 'priceOverride');
  if ('sheetChoice' in j) {
    if (!isObj(j.sheetChoice) || !Object.values(j.sheetChoice).every((v) => typeof v === 'string')) bad('sheetChoice');
    s.sheetChoice = { ...(j.sheetChoice as Record<string, string>) };
  }
  if ('matK' in j) {
    if (!isObj(j.matK)) bad('matK');
    const m: Settings['matK'] = {};
    for (const [id, v] of Object.entries(j.matK as Obj)) {
      if (!isObj(v) || (v.cutK !== undefined && !isNum(v.cutK)) || (v.bendK !== undefined && !isNum(v.bendK))) bad('matK');
      const k = v as { cutK?: number; bendK?: number };
      m[id] = { ...(k.cutK !== undefined ? { cutK: k.cutK } : {}), ...(k.bendK !== undefined ? { bendK: k.bendK } : {}) };
    }
    s.matK = m;
  }
  if ('extraRates' in j) {
    const v = j.extraRates;
    if (!Array.isArray(v) || v.length > MAX_ROWS) bad('extraRates');
    s.extraRates = (v as unknown[]).map((r): ExtraRate => {
      const ok =
        isObj(r) &&
        typeof r.label === 'string' &&
        typeof r.unit === 'string' &&
        isNum(r.price) &&
        (r.note === undefined || r.note === null || typeof r.note === 'string');
      if (!ok) return bad('extraRates');
      const x = r as { label: string; unit: string; price: number; note?: string | null };
      const label = x.label.trim().slice(0, 200);
      const unit = x.unit.trim().slice(0, 40);
      const note = x.note?.trim().slice(0, 500);
      return note ? { label, unit, price: x.price, note } : { label, unit, price: x.price };
    });
  }

  let quote: QuoteSettings | null = null;
  if ('quote' in j && j.quote != null) {
    if (!isObj(j.quote)) bad('quote');
    const src = j.quote as Obj;
    const q: QuoteSettings = { ...DEFAULT_QUOTE };
    const out = q as unknown as Obj;
    for (const k of Object.keys(DEFAULT_QUOTE)) {
      if (!(k in src)) continue;
      if (typeof src[k] !== typeof out[k]) bad(`quote.${k}`);
      out[k] = src[k];
    }
    if (!ROUNDINGS.includes(q.rounding)) bad('quote.rounding');
    if (!isNum(q.validityDays)) bad('quote.validityDays');
    q.validityDays = Math.min(365, Math.round(q.validityDays));
    quote = q;
  }
  return { settings: s, quote };
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** «Сохранить в файл»: расценки и настройки КП одним файлом */
export function exportSettings(): void {
  const { settings, quote } = getState();
  download(FILE_NAME, JSON.stringify({ ...settings, quote }, null, 2));
}

/** «Загрузить из файла»: сразу применить, в уведомлении — «Вернуть» */
export async function importSettings(file: File): Promise<void> {
  try {
    if (file.size > 1_000_000) throw new Error('Файл больше 1 МБ — это не файл расценок');
    const { settings, quote } = parseSettingsFile(await file.text());
    const prev = getState();
    setSettings(settings);
    if (quote) setQuoteSettings(quote);
    undoToast({
      message: quote ? 'Расценки и настройки КП загружены из файла' : 'Расценки загружены из файла',
      undo: () => {
        setSettings(prev.settings);
        setQuoteSettings(prev.quote);
      },
    });
  } catch (e) {
    toast.error(READ_ERROR, { description: e instanceof Error ? e.message : undefined });
  }
}

// ---------- панель ----------

export function SettingsSheet(): ReactElement {
  const sheet = useStore((s) => s.ui.sheet);
  const settings = useStore((s) => s.settings);
  const header = useStore((s) => s.quote.header);
  const open = sheet?.kind === 'settings';
  const tab: SettingsTab = (open ? sheet.tab : null) ?? lastTab;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    lastTab = tab;
    // на узком экране вкладки прокручиваются: открытая всегда видна (например, «КП и цены» из «Заполнить»)
    const id = requestAnimationFrame(() => {
      const strip = stripRef.current;
      const t = strip?.querySelector<HTMLElement>('[role=tab][data-state=active]');
      if (!strip || !t) return;
      const a = strip.getBoundingClientRect();
      const b = t.getBoundingClientRect();
      if (b.left < a.left) strip.scrollLeft += b.left - a.left - 16;
      else if (b.right > a.right) strip.scrollLeft += b.right - a.right + 16;
    });
    return () => cancelAnimationFrame(id);
  }, [open, tab]);

  // «Сбросить» не нужен, если расценки и так по умолчанию
  const isDefault = useMemo(() => JSON.stringify(settings) === JSON.stringify(DEFAULT_SETTINGS), [settings]);

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ''; // тот же файл можно выбрать ещё раз
    if (f) void importSettings(f);
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && closeSheet()}>
      <SheetContent
        side="right"
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[760px]"
        // Esc в поле — сначала вернуть значение поля (это делает само поле), панель закрывает следующий Esc
        onEscapeKeyDown={(e) => isEditable(e.target) && e.preventDefault()}
        // щелчок по уведомлению («Вернуть») — не «мимо панели»: панель остаётся открытой
        onInteractOutside={(e) => inToaster(e.detail.originalEvent.target) && e.preventDefault()}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          // «Шапка КП не заполнена → Заполнить» открывает вкладку «КП и цены»: сразу в поле шапки
          const el = tab === 'quote' && !header ? document.getElementById('set-q-header') : null;
          (el ?? titleRef.current)?.focus();
        }}
        // Radix возвращает фокус только своей кнопке-триггеру, а панель открывают из хранилища — вернуть туда, откуда открыли
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
          opener.current = null;
        }}
      >
        <SheetHeader className="gap-1 pr-12">
          <SheetTitle ref={titleRef} tabIndex={-1} className="text-lg font-semibold outline-none">
            Расценки
          </SheetTitle>
          <SheetDescription className="text-balance">
            Все цены — с НДС. Металл — по ценам mc.ru, резка — по прайсу лазерной резки (₽ за метр реза), гибка — по таблице гибки. Правьте под своего подрядчика.
          </SheetDescription>
        </SheetHeader>

        <Tabs value={tab} onValueChange={(v) => openSheet({ kind: 'settings', tab: v as SettingsTab })} className="min-h-0 flex-1 gap-0">
          <div ref={stripRef} className="overflow-x-auto border-b px-4 pb-3">
            {/* на сенсорном экране вкладки выше (под палец); h-8 списка задан через group-вариант — перебить можно только так */}
            <TabsList aria-label="Разделы расценок" className="pointer-coarse:h-11!">
              {TABS.map(([v, label]) => (
                <TabsTrigger key={v} value={v} className="px-2.5">
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-5 pb-8">
            <TabsContent value="cut" className="focus-ring rounded-sm">
              <CuttingTab />
            </TabsContent>
            <TabsContent value="bend" className="focus-ring rounded-sm">
              <BendingTab />
            </TabsContent>
            <TabsContent value="mat" className="focus-ring rounded-sm">
              <MaterialsTab />
            </TabsContent>
            <TabsContent value="nest" className="focus-ring rounded-sm">
              <NestingTab />
            </TabsContent>
            <TabsContent value="extra" className="focus-ring rounded-sm">
              <ExtraOpsTab />
            </TabsContent>
            <TabsContent value="quote" className="focus-ring rounded-sm">
              <QuoteSettingsTab />
            </TabsContent>
          </div>
        </Tabs>

        <SheetFooter className="mt-0 gap-2.5 border-t">
          {/* файлы слева, «Сбросить» справа: уведомление «Вернуть» появляется справа внизу — прямо над кнопкой
              и не закрывает кнопки файлов; на телефоне у файлов только значки (подпись — для чтения с экрана) */}
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={exportSettings} title="Сохранить в файл" className="max-sm:px-2 pointer-coarse:h-9">
              <Download data-icon="inline-start" />
              <span className="max-sm:sr-only">Сохранить в файл</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => fileRef.current?.click()}
              title="Загрузить из файла"
              className="max-sm:px-2 pointer-coarse:h-9"
            >
              <Upload data-icon="inline-start" />
              <span className="max-sm:sr-only">Загрузить из файла</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={resetSettings}
              disabled={isDefault}
              title={isDefault ? 'Расценки и так по умолчанию' : 'Вернуть расценки по умолчанию; настройки КП останутся'}
              className="ms-auto pointer-coarse:h-9"
            >
              <RotateCcw data-icon="inline-start" />
              Сбросить
            </Button>
          </div>
          <p className="text-xs leading-normal text-muted-foreground">
            Сохраняется сразу. Расценки входят в анализ ИИ — после правки он будет помечен устаревшим.
          </p>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden tabIndex={-1} onChange={onFile} />
        </SheetFooter>
        {/* Модальная панель выключает щелчки вне себя (body pointer-events: none) — и уведомления тоже.
            Пока панель открыта, уведомления остаются нажимаемыми, иначе «Вернуть» после «Сбросить» не работает. */}
        <style>{'[data-sonner-toast] { pointer-events: auto; }'}</style>
      </SheetContent>
    </Sheet>
  );
}
