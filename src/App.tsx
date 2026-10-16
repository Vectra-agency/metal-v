import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { computeOrder, type PriceBook, type Settings } from './core/pricing.ts';
import { exportCsv } from './exportCsv.ts';
import { date, plural } from './format.ts';
import {
  emptyOrder,
  fetchPrices,
  filesFromDrop,
  importDxf,
  loadOrder,
  loadSettings,
  newId,
  refreshPricesApi,
  saveOrder,
  saveSettings,
  type Order,
  type OrderPosition,
} from './order.ts';
import { ManualDialog } from './components/ManualDialog.tsx';
import type { QtyLine } from './core/pdfAnalyze.ts';
import { mergeImports } from './merge.ts';
import { importPdf } from './pdfImport.ts';
import { clearFiles } from './idb.ts';
import { PositionsTable } from './components/PositionsTable.tsx';
import { SettingsDrawer } from './components/SettingsDrawer.tsx';
import { SheetsSection } from './components/SheetsSection.tsx';
import { SummaryStrip } from './components/SummaryStrip.tsx';

const EMPTY_BOOK: PriceBook = { updatedAt: null, region: 'Санкт-Петербург', materials: {} };

interface Notice {
  id: number;
  kind: 'info' | 'warn' | 'error';
  text: string;
}

export function App() {
  const [order, setOrder] = useState<Order>(loadOrder);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [book, setBook] = useState<PriceBook>(EMPTY_BOOK);
  const [live, setLive] = useState(false);
  const [priceBusy, setPriceBusy] = useState<string | null>('Загрузка цен…');
  const [notices, setNotices] = useState<Notice[]>([]);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState<{ done: number; total: number } | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);

  const notify = useCallback((kind: Notice['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setNotices((n) => [...n, { id, kind, text }]);
    setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), kind === 'info' ? 5000 : 12000);
  }, []);

  // цены: API сервера или вшитый снимок
  useEffect(() => {
    fetchPrices()
      .then(({ book, live }) => {
        setBook(book);
        setLive(live);
      })
      .catch(() => {
        setBook({ ...EMPTY_BOOK }); // считаем по ценам по умолчанию
        notify('error', 'Не удалось загрузить цены — используются цены по умолчанию');
      })
      .finally(() => setPriceBusy(null));
  }, [notify]);

  // автосохранение (+ немедленно при закрытии вкладки)
  const latest = useRef(order);
  latest.current = order;
  useEffect(() => {
    const flush = () => saveOrder(latest.current);
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => {
      const err = saveOrder(order);
      if (err) notify('warn', err);
    }, 400);
    return () => clearTimeout(t);
  }, [order, notify]);
  useEffect(() => saveSettings(settings), [settings]);

  const res = useMemo(
    () =>
      computeOrder(order.positions, book, {
        ...settings,
        sheetChoice: order.sheetChoice,
        priceOverride: order.priceOverride,
        markupPct: order.markupPct,
        delivery: order.delivery,
      }),
    [order, book, settings],
  );

  const patchOrder = (patch: Partial<Order>) => setOrder((o) => ({ ...o, ...patch }));
  const updatePos = (id: string, patch: Partial<OrderPosition>) =>
    setOrder((o) => ({ ...o, positions: o.positions.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
  const bulk = (ids: string[], patch: Partial<OrderPosition>) => {
    const set = new Set(ids);
    setOrder((o) => ({
      ...o,
      positions: o.positions.map((p) =>
        set.has(p.id)
          ? {
              ...p,
              ...patch,
              guessed: {
                material: patch.materialId ? false : p.guessed.material,
                thickness: patch.thickness ? false : p.guessed.thickness,
                qty: patch.qty ? false : p.guessed.qty,
              },
            }
          : p,
      ),
    }));
  };
  const remove = (ids: string[]) => {
    const set = new Set(ids);
    setOrder((o) => ({ ...o, positions: o.positions.filter((p) => !set.has(p.id)) }));
  };
  const duplicate = (id: string) =>
    setOrder((o) => {
      const i = o.positions.findIndex((p) => p.id === id);
      if (i < 0) return o;
      const copy = { ...structuredClone(o.positions[i]), id: newId(), name: o.positions[i].name + ' (копия)' };
      const positions = o.positions.slice();
      positions.splice(i + 1, 0, copy);
      return { ...o, positions };
    });

  const defaults = () => {
    const last = order.positions.at(-1);
    return { materialId: last?.materialId ?? 'st3', thickness: last?.thickness ?? 2 };
  };

  const handleFiles = async (files: File[]) => {
    const dxf = files.filter((f) => /\.dxf$/i.test(f.name));
    const pdf = files.filter((f) => /\.pdf$/i.test(f.name));
    const archives = files.filter((f) => /\.(zip|rar|7z)$/i.test(f.name));
    const other = files.length - dxf.length - pdf.length - archives.length;
    if (archives.length) notify('warn', `Архивы (${archives.map((a) => a.name).join(', ')}) нужно распаковать и перетащить папку`);
    if (other > 0) notify('info', `Пропущено файлов (не DXF и не PDF): ${other}`);
    const existing = new Set(order.positions.map((p) => p.fileName));
    const fresh = [...dxf, ...pdf].filter((f) => !existing.has(f.name));
    if (fresh.length < dxf.length + pdf.length) notify('info', `Уже в заказе, пропущено: ${dxf.length + pdf.length - fresh.length}`);
    if (!fresh.length) return;
    const d = defaults();
    const addedDxf: OrderPosition[] = [];
    const addedPdf: OrderPosition[] = [];
    const qty: QtyLine[] = [];
    const skipped: string[] = [];
    setImporting({ done: 0, total: fresh.length });
    for (let i = 0; i < fresh.length; i++) {
      const f = fresh[i];
      try {
        if (/\.pdf$/i.test(f.name)) {
          const r = await importPdf(f, d);
          addedPdf.push(...r.positions);
          qty.push(...r.qty);
          skipped.push(...r.notes);
        } else addedDxf.push(await importDxf(f, d));
      } catch (e) {
        notify('error', `${f.name}: ${(e as Error).message}`);
      }
      setImporting({ done: i + 1, total: fresh.length });
      if (i % 10 === 9 || /\.pdf$/i.test(f.name)) await new Promise((r) => setTimeout(r, 0)); // даём отрисоваться прогрессу
    }
    setImporting(null);
    const byFile = (a: OrderPosition, b: OrderPosition) => (a.fileName ?? '').localeCompare(b.fileName ?? '', 'ru');
    addedDxf.sort(byFile);
    addedPdf.sort(byFile);
    const m = mergeImports(latest.current.positions, addedDxf, addedPdf, qty);
    const notes = m.notes;
    setOrder((o) => ({ ...o, positions: m.positions }));
    const added = [...addedDxf, ...addedPdf];
    const guessed = added.filter((p) => p.guessed.material || p.guessed.thickness).length;
    // после слияния: позиции этой загрузки, где количество так и не нашлось
    const addedIds = new Set(added.map((p) => p.id));
    const noQty = m.positions.filter((p) => addedIds.has(p.id) && !p.disabled && p.guessed.qty).length;
    if (added.length) notify('info', `Обработано ${added.length} ${plural(added.length, 'деталь', 'детали', 'деталей')}${addedPdf.length ? `, из них по PDF: ${addedPdf.length}` : ''}`);
    if (notes.length) notify('info', notes.slice(0, 6).join('\n') + (notes.length > 6 ? `\n… ещё ${notes.length - 6}` : ''));
    if (skipped.length) notify('warn', skipped.slice(0, 5).join('\n'));
    if (guessed) notify('warn', `У ${guessed} поз. материал или толщина не распознаны — подсвечены жёлтым`);
    if (noQty) notify('info', `Количество не указано у ${noQty} поз. — стоит 1 шт, поле подсвечено`);
  };

  // перетаскивание на всё окно
  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => e.preventDefault();
    const drop = async (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (e.dataTransfer) handleFiles(await filesFromDrop(e.dataTransfer));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  });

  const refreshPrices = async () => {
    const pairs = res.groups.map((g) => [g.material.id, g.t] as [string, number]);
    if (!pairs.length && !confirm('В заказе нет деталей. Обновить весь справочник цен? Это займёт около 2–3 минут.')) return;
    setPriceBusy(pairs.length ? `Обновляю цены mc.ru (${pairs.length} поз.)…` : 'Обновляю весь справочник mc.ru…');
    try {
      const r = await refreshPricesApi(pairs.length ? pairs : null);
      setBook(r.book);
      if (r.errors.length) notify('warn', r.errors.join('\n'));
      else notify('info', 'Цены mc.ru обновлены');
    } catch (e) {
      notify('error', `Не удалось обновить цены: ${(e as Error).message}`);
    } finally {
      setPriceBusy(null);
    }
  };

  const ageDays = book.updatedAt ? (Date.now() - new Date(book.updatedAt).getTime()) / 864e5 : Infinity;
  const estimateGroups = res.groups.filter((g) => g.chosen.offer.source === 'estimate');
  const hasPositions = order.positions.length > 0;
  const pricesReady = book !== EMPTY_BOOK;

  return (
    <div className="app">
      <header className="topbar no-print">
        <div className="brand">
          <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
            <rect x="3" y="8" width="26" height="16" rx="2" fill="var(--c-metal)" />
            <path d="M8 8v16M24 8v16" stroke="var(--surface)" strokeWidth="2" strokeDasharray="3 2" />
          </svg>
          <div>
            <div className="brand-title">Расчёт деталей</div>
            <div className="brand-sub">металл · лазер · гибка</div>
          </div>
        </div>
        <input className="order-title" value={order.title} placeholder="Название заказа / клиента" onChange={(e) => patchOrder({ title: e.target.value })} />
        <div className="price-chip" title={estimateGroups.length ? `Нет цены mc.ru для: ${estimateGroups.map((g) => `${g.material.short} ${g.t} мм`).join(', ')}` : ''}>
          <span className={`led ${priceBusy ? 'busy' : ageDays > 7 ? 'old' : 'ok'}`} />
          {priceBusy ?? (
            <>
              Цены mc.ru · {book.region} · {date(book.updatedAt)}
              {estimateGroups.length > 0 && <span className="warn-text"> · {estimateGroups.length} без цены</span>}
            </>
          )}
          {live ? (
            <button className="btn small" disabled={!!priceBusy} onClick={refreshPrices}>
              Обновить
            </button>
          ) : (
            !priceBusy && (
              <span className="muted small" title="Запустите npm run dev или npm run serve — тогда цены можно обновлять с mc.ru">
                (снимок)
              </span>
            )
          )}
        </div>
        <div className="top-actions">
          <button className="btn" onClick={() => setShowSettings(true)}>
            Расценки
          </button>
          <button className="btn" disabled={!hasPositions} onClick={() => exportCsv(order, res)}>
            Excel (CSV)
          </button>
          <button className="btn" disabled={!hasPositions} onClick={() => window.print()}>
            Печать
          </button>
          <button
            className="btn ghost"
            disabled={!hasPositions}
            onClick={() => {
              if (confirm('Начать новый расчёт? Текущий заказ будет очищен.')) {
                setOrder(emptyOrder());
                clearFiles();
              }
            }}
          >
            Новый
          </button>
        </div>
      </header>

      <div className="print-only print-head">
        <h1>Расчёт стоимости изготовления деталей{order.title ? ` — ${order.title}` : ''}</h1>
        <div>
          {new Date().toLocaleDateString('ru-RU')} · цены металла mc.ru ({book.region}) от {date(book.updatedAt)}
        </div>
      </div>

      <main className="layout">
        {hasPositions && (pricesReady ? <SummaryStrip res={res} order={order} vatPct={settings.vatPct} onOrder={patchOrder} /> : <div className="card summary-loading">Загружаю цены металла…</div>)}

        <section className="positions">
          <div className="toolbar no-print">
            <h2>Детали</h2>
            <div className="toolbar-actions">
              <button className="btn primary" onClick={() => fileInput.current?.click()}>
                + DXF / PDF
              </button>
              <button className="btn" onClick={() => dirInput.current?.click()}>
                + Папка
              </button>
              <button className="btn" onClick={() => setShowManual(true)}>
                + Деталь без чертежа
              </button>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept=".dxf,.DXF,.pdf,.PDF"
              multiple
              hidden
              onChange={(e) => {
                handleFiles([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
            <input
              ref={dirInput}
              type="file"
              hidden
              multiple
              {...({ webkitdirectory: '' } as object)}
              onChange={(e) => {
                handleFiles([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
          </div>

          {importing && (
            <div className="progress">
              Читаю чертежи: {importing.done} из {importing.total}
              <div className="progress-bar">
                <span style={{ width: `${(importing.done / Math.max(1, importing.total)) * 100}%` }} />
              </div>
            </div>
          )}

          {hasPositions ? (
            <PositionsTable
              positions={order.positions}
              res={res}
              settings={settings}
              onUpdate={updatePos}
              onBulk={bulk}
              onRemove={remove}
              onDuplicate={duplicate}
              highlight={highlight}
              onHighlight={setHighlight}
            />
          ) : (
            <div className="dropzone" onClick={() => fileInput.current?.click()}>
              <div className="dz-icon" aria-hidden>
                ⤓
              </div>
              <div className="dz-title">Перетащите сюда DXF или PDF-чертежи — можно целую папку</div>
              <ol className="dz-steps">
                <li>
                  <b>DXF</b> — точный контур; материал, толщина и количество берутся из имени: <code>НГЭН.745421.0001 st3 s2mm 5sht.dxf</code>
                </li>
                <li>
                  <b>PDF</b> — программа найдёт развёртку, масштаб, линии гиба, материал и толщину из штампа, размеры из таблицы исполнений и сверит массу
                  с чертежом. Если пришли и DXF, и PDF одной детали — они объединятся
                </li>
                <li>Контур, отверстия, длина реза, врезки, масса, раскладка по листам — считаются сами</li>
                <li>Проверьте подсвеченные поля и укажите число гибов — цена за деталь и по заказу считается сразу</li>
              </ol>
              <div className="dz-actions" onClick={(e) => e.stopPropagation()}>
                <button className="btn primary" onClick={() => fileInput.current?.click()}>
                  Выбрать файлы
                </button>
                <button className="btn" onClick={() => dirInput.current?.click()}>
                  Выбрать папку
                </button>
                <button className="btn" onClick={() => setShowManual(true)}>
                  Деталь без чертежа
                </button>
              </div>
            </div>
          )}
        </section>

        {hasPositions && (
          <SheetsSection
            res={res}
            order={order}
            settings={settings}
            onOrder={patchOrder}
            onSettings={(p) => setSettings((s) => ({ ...s, ...p }))}
            highlight={highlight}
            onHighlight={setHighlight}
          />
        )}
      </main>

      {dragging && (
        <div className="drop-overlay no-print">
          <div>Отпустите — добавлю чертежи в расчёт</div>
        </div>
      )}
      {showSettings && <SettingsDrawer settings={settings} onChange={setSettings} onClose={() => setShowSettings(false)} />}
      {showManual && (
        <ManualDialog
          defaults={defaults()}
          onAdd={(p) => setOrder((o) => ({ ...o, positions: [...o.positions, p] }))}
          onClose={() => setShowManual(false)}
        />
      )}
      <div className="notices no-print" aria-live="polite">
        {notices.map((n) => (
          <div key={n.id} className={`notice ${n.kind}`} onClick={() => setNotices((x) => x.filter((y) => y.id !== n.id))}>
            {n.text}
          </div>
        ))}
      </div>
    </div>
  );
}

