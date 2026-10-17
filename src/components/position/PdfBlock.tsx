// Блок «Распознано из PDF» в карточке: вид и масштаб, штамп, сверка массы, исполнение по таблице, примечания,
// «Открыть чертёж и проверить» и габарит вручную (для сканов и деталей без контура).
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.tsx';
import { NumInput } from '@/components/common/NumInput.tsx';
import { Ruler, ScanSearch } from 'lucide-react';
import type { PdfMeta } from '@/core/pdfAnalyze.ts';
import { kg, n1, NBSP } from '@/format.ts';
import { cn } from '@/lib/utils.ts';
import { manualPosition, type OrderPosition } from '@/order.ts';
import { geometryPatch, pdfCheck } from '@/pdfImport.ts';
import { editPosition, openDialog } from '@/store/actions.ts';
import { scaleLabel } from './PdfDrawingView.tsx';

/** Предупреждения, которые снимает выбор вида/исполнения на чертеже */
export const VIEW_WARN = /таблица исполнений|Масштаб вида|обрывом/;

/** Сменить исполнение по таблице (как в старом PdfBlock.applyMeta) */
export function applyVariant(p: OrderPosition, m: PdfMeta): void {
  if (!p.pdf) return;
  const scan = !p.pdf.meta.base.outer.length;
  // обозначение позиции — как у выбранного исполнения
  const name = m.table && m.row >= 0 ? m.table.rows[m.row].designation : p.name;
  if (p.pdf.geometryFromPdf || scan) {
    editPosition(p.id, {
      ...geometryPatch(m, p),
      name,
      pdf: { ...p.pdf, meta: m, geometryFromPdf: true },
      warnings: p.warnings.filter((w) => !VIEW_WARN.test(w)),
    });
  } else editPosition(p.id, { name, pdf: { ...p.pdf, meta: m } });
}

// ---------- габарит вручную ----------

export interface ManualDimsProps {
  p: OrderPosition; // базовая позиция
  autoFocus: number; // меняется — поставить фокус в «Ширину»
  onDone?: () => void;
}

/** Прямоугольник по габариту с круглыми отверстиями — когда контур не распознался */
export function ManualDims({ p, autoFocus, onDone }: ManualDimsProps): ReactElement {
  const [dims, setDims] = useState({ width: Math.round(p.geom.width) || 0, height: Math.round(p.geom.height) || 0, holes: 0, holeD: 10 });
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    const t = setTimeout(() => {
      const el = box.current?.querySelector<HTMLInputElement>('input');
      el?.scrollIntoView({ block: 'center' });
      el?.focus();
      el?.select();
    }, 60);
    return () => clearTimeout(t);
  }, [autoFocus]);
  const apply = () => {
    const mp = manualPosition({ name: p.name, materialId: p.materialId, thickness: p.thickness, qty: p.qty, bends: p.bends, ...dims });
    editPosition(p.id, {
      geom: mp.geom,
      preview: mp.preview,
      bendLength: p.bendLength || mp.bendLength,
      ...(p.pdf ? { pdf: { ...p.pdf, geometryFromPdf: false } } : {}),
      warnings: p.warnings.filter((w) => !/скан|габарит|контур/i.test(w)),
    });
    onDone?.();
  };
  const field = 'flex flex-col gap-1 text-xs text-muted-foreground';
  return (
    <div ref={box} data-sheet-focus="dims" className="space-y-2 rounded-md border border-dashed p-3">
      <p className="text-xs text-muted-foreground">Прямоугольник по габариту с круглыми отверстиями — если контур не распознался.</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className={field}>
          Ширина
          <NumInput value={dims.width} suffix="мм" aria-label="Ширина, мм" onChange={(v) => setDims({ ...dims, width: v })} onEnter={() => {}} className="w-28" />
        </label>
        <label className={field}>
          Длина
          <NumInput value={dims.height} suffix="мм" aria-label="Длина, мм" onChange={(v) => setDims({ ...dims, height: v })} onEnter={() => {}} className="w-28" />
        </label>
        <label className={field}>
          Отверстий
          <NumInput value={dims.holes} aria-label="Отверстий" onChange={(v) => setDims({ ...dims, holes: Math.round(v) })} onEnter={() => {}} className="w-16" />
        </label>
        <label className={field}>
          Ø
          <NumInput value={dims.holeD} suffix="мм" aria-label="Диаметр отверстий, мм" onChange={(v) => setDims({ ...dims, holeD: v })} onEnter={() => {}} className="w-24" />
        </label>
        <Button size="sm" disabled={!dims.width || !dims.height} onClick={apply}>
          Применить габарит
        </Button>
      </div>
    </div>
  );
}

// ---------- блок PDF ----------

export interface PdfBlockProps {
  base: OrderPosition; // базовая: геометрия и PDF (их ИИ не меняет)
  pos: OrderPosition; // с предложениями ИИ: материал и толщина для сверки массы
  focusDims: number; // меняется — открыть «Габарит вручную» и поставить фокус
}

export function PdfBlock({ base, pos, focusDims }: PdfBlockProps): ReactElement | null {
  const pdf = base.pdf;
  const scan = !!pdf && !pdf.meta.base.outer.length;
  const [manual, setManual] = useState(scan || base.geom.netArea <= 0 || focusDims > 0);
  useEffect(() => {
    if (focusDims) setManual(true);
  }, [focusDims]);
  if (!pdf) return null;
  const meta = pdf.meta;
  const c = pdfCheck(pos);
  const heading = pdf.geometryFromPdf ? 'Распознано из PDF' : scan ? 'PDF-скан' : 'Данные из PDF';
  return (
    <section aria-labelledby="pdf-h" className="space-y-2 text-sm">
      <h3 id="pdf-h" className="text-sm font-semibold">
        {heading}
      </h3>
      {!scan && (
        <p>
          {pdf.geometryFromPdf ? (
            <>
              Вид на стр. {meta.page + 1}, масштаб {scaleLabel(meta.scale)} <span className="text-muted-foreground">({meta.scaleWhy})</span>
            </>
          ) : (
            <span className="text-muted-foreground">Контур — из DXF; из PDF взяты гибы, материал и масса для сверки.</span>
          )}
        </p>
      )}
      {(meta.title.materialText || meta.title.thickness) && (
        <p className="text-muted-foreground">
          Штамп: {meta.title.materialText ?? '—'}
          {meta.title.thickness ? `, лист ${n1(meta.title.thickness)}${NBSP}мм` : ''}
        </p>
      )}
      {c && c.status !== 'unknown' && (
        <p className={cn(c.status === 'ok' ? 'text-ok' : c.status === 'warn' ? 'text-warn' : 'text-danger')}>
          Масса: по контуру {kg(c.calc)}, по чертежу {kg(c.drawing!)}
          {c.status === 'ok' ? ' — совпадает ✓' : ` — расхождение ${n1(Math.abs((c.ratio! - 1) * 100))}${NBSP}%, проверьте вид и масштаб`}
          {c.densityNote && <span className="text-muted-foreground"> ({c.densityNote})</span>}
        </p>
      )}
      {meta.table && meta.table.rows.length > 0 && (
        <div data-sheet-focus="variant" className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">Исполнение по таблице</span>
          <Select value={String(meta.row)} onValueChange={(v) => applyVariant(base, { ...meta, row: Number(v) })}>
            <SelectTrigger size="sm" aria-label="Исполнение по таблице" className="min-w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              <SelectItem value="-1">как нарисовано</SelectItem>
              {meta.table.rows.map((r, i) => (
                <SelectItem key={i} value={String(i)}>
                  {r.designation}
                  {r.values.mass ? ` — ${n1(r.values.mass)}${NBSP}кг` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {pdf.notes.length > 0 && <p className="text-xs text-muted-foreground">{pdf.notes.join('; ')}</p>}
      <div className="flex flex-wrap gap-2 pt-1">
        {!scan && (
          <Button size="sm" variant="outline" onClick={() => openDialog({ kind: 'pdfReview', id: base.id })}>
            <ScanSearch />
            Открыть чертёж и проверить
          </Button>
        )}
        <Button size="sm" variant="ghost" aria-expanded={manual} onClick={() => setManual((v) => !v)}>
          <Ruler />
          Габарит вручную
        </Button>
      </div>
      {manual && <ManualDims p={base} autoFocus={focusDims} onDone={() => setManual(false)} />}
    </section>
  );
}
