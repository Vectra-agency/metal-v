import { useState } from 'react';
import type { PdfMeta } from '../core/pdfAnalyze.ts';
import { kg, n1 } from '../format.ts';
import { manualPosition, type OrderPosition } from '../order.ts';
import { geometryPatch, pdfCheck } from '../pdfImport.ts';
import { NumInput } from './NumInput.tsx';
import { PdfReview } from './PdfReview.tsx';

const scaleLabel = (s: number) => (s >= 1 ? `1:${String(s).replace('.', ',')}` : `${String(1 / s).replace('.', ',')}:1`);

/** Значок в строке таблицы: позиция распознана из PDF + сверка массы */
export function PdfBadge({ p }: { p: OrderPosition }) {
  if (!p.pdf) return null;
  const c = pdfCheck(p);
  const fromDxf = !p.pdf.geometryFromPdf && p.source === 'dxf';
  const label = fromDxf ? 'DXF + PDF' : 'PDF';
  if (!c || c.status === 'unknown') return <span className="badge" title="Распознано по PDF; массы на чертеже нет">{label}</span>;
  const pct = c.ratio ? `${c.ratio >= 1 ? '+' : ''}${n1((c.ratio - 1) * 100)}%` : '';
  const title = `Масса по контуру ${kg(c.calc)}, по чертежу ${c.drawing ? kg(c.drawing) : '—'}`;
  if (c.status === 'ok') return <span className="badge ok" title={title}>{label} ✓ масса</span>;
  return (
    <span className={`badge ${c.status}`} title={title}>
      {label} ⚠ масса {pct}
    </span>
  );
}

interface Props {
  p: OrderPosition;
  onUpdate: (id: string, patch: Partial<OrderPosition>) => void;
}

/** Блок «Распознано из PDF» в карточке позиции */
export function PdfBlock({ p, onUpdate }: Props) {
  const [review, setReview] = useState(false);
  const [manual, setManual] = useState(p.geom.netArea === 0);
  const [dims, setDims] = useState({ width: Math.round(p.geom.width) || 0, height: Math.round(p.geom.height) || 0, holes: 0, holeD: 10 });
  if (!p.pdf) return null;
  const meta = p.pdf.meta;
  const c = pdfCheck(p);
  const scan = !meta.base.outer.length;

  const applyMeta = (m: PdfMeta) => {
    // обозначение позиции — как у выбранного исполнения
    const name = m.table && m.row >= 0 ? m.table.rows[m.row].designation : p.name;
    if (p.pdf!.geometryFromPdf || scan) {
      onUpdate(p.id, {
        ...geometryPatch(m, p),
        name,
        pdf: { ...p.pdf!, meta: m, geometryFromPdf: true },
        warnings: p.warnings.filter((w) => !/таблица исполнений|Масштаб вида|обрывом/.test(w)),
      });
    } else onUpdate(p.id, { name, pdf: { ...p.pdf!, meta: m } });
  };
  const applyFromReview = (m: PdfMeta) =>
    onUpdate(p.id, {
      ...geometryPatch(m, p),
      source: 'pdf',
      pdf: { ...p.pdf!, meta: m, geometryFromPdf: true },
      warnings: p.warnings.filter((w) => !/таблица исполнений|Масштаб вида|обрывом/.test(w)),
    });
  const applyManual = () => {
    const mp = manualPosition({ name: p.name, materialId: p.materialId, thickness: p.thickness, qty: p.qty, bends: p.bends, ...dims });
    onUpdate(p.id, { geom: mp.geom, preview: mp.preview, bendLength: p.bendLength || mp.bendLength, pdf: { ...p.pdf!, geometryFromPdf: false }, warnings: p.warnings.filter((w) => !/скан|габарит/i.test(w)) });
    setManual(false);
  };

  return (
    <div className="pdf-block">
      <h4>{p.pdf.geometryFromPdf ? 'Распознано из PDF' : scan ? 'PDF-скан' : 'Данные из PDF'}</h4>
      {!scan && (
        <div className="small">
          {p.pdf.geometryFromPdf ? (
            <>
              Вид на стр. {meta.page + 1}, масштаб {scaleLabel(meta.scale)} <span className="muted">({meta.scaleWhy})</span>
            </>
          ) : (
            <span className="muted">Контур — из DXF; из PDF взяты гибы, материал и масса для сверки.</span>
          )}
        </div>
      )}
      {(meta.title.materialText || meta.title.thickness) && (
        <div className="small muted">
          Штамп: {meta.title.materialText ?? '—'}
          {meta.title.thickness ? `, лист ${n1(meta.title.thickness)} мм` : ''}
        </div>
      )}
      {c && c.status !== 'unknown' && (
        <div className={`small mass-${c.status}`}>
          Масса: по контуру {kg(c.calc)}, по чертежу {kg(c.drawing!)}
          {c.status === 'ok' ? ' — совпадает ✓' : ` — расхождение ${n1(Math.abs((c.ratio! - 1) * 100))}%, проверьте вид и масштаб`}
          {c.densityNote && <span className="muted"> ({c.densityNote})</span>}
        </div>
      )}
      {meta.table && meta.table.rows.length > 0 && (
        <label className="field small">
          <span>Исполнение по таблице</span>
          <select value={meta.row} onChange={(e) => applyMeta({ ...meta, row: Number(e.target.value) })}>
            <option value={-1}>как нарисовано</option>
            {meta.table.rows.map((r, i) => (
              <option key={i} value={i}>
                {r.designation}
                {r.values.mass ? ` — ${n1(r.values.mass)} кг` : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      {p.pdf.notes.length > 0 && <div className="small muted">{p.pdf.notes.join('; ')}</div>}
      <div className="row-actions">
        {!scan && (
          <button className="btn small" onClick={() => setReview(true)}>
            Открыть чертёж и проверить
          </button>
        )}
        <button className="btn small ghost" onClick={() => setManual((v) => !v)}>
          Габарит вручную
        </button>
      </div>
      {manual && (
        <div className="manual-geom">
          <div className="small muted">Прямоугольник по габариту с круглыми отверстиями — если контур не распознался.</div>
          <div className="field-row">
            <label className="field">
              <span>Ширина</span>
              <NumInput value={dims.width} suffix="мм" width={64} onChange={(v) => setDims({ ...dims, width: v })} />
            </label>
            <label className="field">
              <span>Длина</span>
              <NumInput value={dims.height} suffix="мм" width={64} onChange={(v) => setDims({ ...dims, height: v })} />
            </label>
            <label className="field">
              <span>Отверстий</span>
              <NumInput value={dims.holes} width={44} onChange={(v) => setDims({ ...dims, holes: Math.round(v) })} />
            </label>
            <label className="field">
              <span>Ø</span>
              <NumInput value={dims.holeD} suffix="мм" width={50} onChange={(v) => setDims({ ...dims, holeD: v })} />
            </label>
          </div>
          <button className="btn small primary" disabled={!dims.width || !dims.height} onClick={applyManual}>
            Применить габарит
          </button>
        </div>
      )}
      {review && <PdfReview p={p} onApply={applyFromReview} onClose={() => setReview(false)} />}
    </div>
  );
}
