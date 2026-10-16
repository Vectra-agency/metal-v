import { useEffect, useMemo, useRef, useState } from 'react';
import { buildGeometry, STD_SCALES, type PdfMeta } from '../core/pdfAnalyze.ts';
import { kg, m, n0, n1, n2 } from '../format.ts';
import type { OrderPosition } from '../order.ts';
import { pdfCheck, reanalyze, renderPage, repick, type Reanalysis } from '../pdfImport.ts';

interface Props {
  p: OrderPosition;
  onApply: (meta: PdfMeta) => void;
  onClose: () => void;
}

const scaleLabel = (s: number) => (s >= 1 ? `1:${String(s).replace('.', ',')}` : `${String(1 / s).replace('.', ',')}:1`);

/** Проверка распознавания: страница PDF, найденные виды, выбор вида/масштаба/исполнения */
export function PdfReview({ p, onApply, onClose }: Props) {
  const pdf = p.pdf!;
  const [re, setRe] = useState<Reanalysis | null | undefined>(undefined);
  const [meta, setMeta] = useState<PdfMeta>(pdf.meta);
  const [cand, setCand] = useState<number>(-1);
  const [page, setPage] = useState(pdf.meta.page);
  const [paper, setPaper] = useState<{ w: number; h: number } | null>(null);
  const [hover, setHover] = useState<number>(-1);
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    reanalyze(p).then((r) => {
      setRe(r);
      if (r) {
        // какой из найденных видов сейчас выбран
        const b = pdf.meta.base.bbox;
        const i = r.an.candidates.findIndex((c) => c.page === pdf.meta.page && Math.abs(c.bbox.minX - b.minX) < 0.05 && Math.abs(c.bbox.minY - b.minY) < 0.05);
        setCand(i);
      }
    });
  }, [p, pdf.meta]);

  useEffect(() => {
    if (!canvas.current || !wrap.current) return;
    const w = Math.min(980, wrap.current.clientWidth);
    renderPage(pdf.fileKey, page, canvas.current, w).then(setPaper);
  }, [pdf.fileKey, page]);

  const pages = useMemo(() => (re ? re.pages.map((x) => x.index) : [pdf.meta.page]), [re, pdf.meta.page]);
  const g = useMemo(() => (meta.base.outer.length ? buildGeometry(meta) : null), [meta]);
  const check = g ? pdfCheck({ ...p, geom: { ...p.geom, netArea: g.netArea }, pdf: { ...pdf, meta } }) : null;

  const choose = (i: number, scale?: number) => {
    if (!re) return;
    setCand(i);
    setMeta(repick(re, { ...p, pdf: { ...pdf, meta } }, i, scale));
  };

  return (
    <div className="drawer-backdrop center" onClick={onClose}>
      <div className="review" role="dialog" aria-label="Проверка PDF" onClick={(e) => e.stopPropagation()}>
        <div className="review-sheet" ref={wrap}>
          {re === null && <div className="note">Файл PDF не сохранён в браузере — перетащите его ещё раз, чтобы открыть чертёж.</div>}
          <div className="review-canvas">
            <canvas ref={canvas} />
            {paper && re && (
              <svg viewBox={`0 0 ${paper.w} ${paper.h}`} className="review-overlay">
                <g transform={`matrix(1 0 0 -1 0 ${paper.h})`}>
                  {re.an.candidates.map((c, i) =>
                    c.page !== page ? null : (
                      <path
                        key={i}
                        d={'M' + c.part.outer.pts.map((v) => `${v.x} ${v.y}`).join('L') + 'Z'}
                        className={`rv-cand ${i === cand ? 'sel' : ''} ${i === hover ? 'hov' : ''}`}
                        onMouseEnter={() => setHover(i)}
                        onMouseLeave={() => setHover(-1)}
                        onClick={() => choose(i)}
                      >
                        <title>Вид {i + 1}: щёлкните, чтобы считать по нему</title>
                      </path>
                    ),
                  )}
                </g>
              </svg>
            )}
          </div>
          {pages.length > 1 && (
            <div className="review-pages">
              {pages.map((i) => (
                <button key={i} className={`chip ${i === page ? 'active' : ''}`} onClick={() => setPage(i)}>
                  стр. {i + 1}
                </button>
              ))}
            </div>
          )}
        </div>

        <aside className="review-side">
          <header className="drawer-h">
            <h2>Проверка чертежа</h2>
            <button className="iconbtn" onClick={onClose} aria-label="Закрыть">
              ✕
            </button>
          </header>
          <div className="small muted">{pdf.meta.fileName}</div>
          <p className="small">
            Синим обведены найденные виды, <b className="accent-text">выбранный</b> — залит. Если программа взяла не тот вид, щёлкните нужный на чертеже.
          </p>
          {!pdf.geometryFromPdf && <div className="note small">Сейчас контур взят из DXF. «Применить» заменит его контуром с чертежа.</div>}

          <label className="field">
            <span>Масштаб вида</span>
            <select value={String(meta.scale)} onChange={(e) => cand >= 0 && choose(cand, Number(e.target.value))} disabled={cand < 0}>
              {[...new Set([meta.scale, ...STD_SCALES])].sort((a, b) => a - b).map((s) => (
                <option key={s} value={String(s)}>
                  {scaleLabel(s)}
                </option>
              ))}
            </select>
          </label>
          <div className="small muted">{meta.scaleWhy}</div>

          {meta.table && meta.table.rows.length > 0 && (
            <label className="field">
              <span>Исполнение</span>
              <select value={meta.row} onChange={(e) => setMeta({ ...meta, row: Number(e.target.value) })}>
                <option value={-1}>как нарисовано</option>
                {meta.table.rows.map((r, i) => (
                  <option key={i} value={i}>
                    {r.designation} — {Object.entries(r.values).map(([k, v]) => `${k === 'mass' ? 'масса' : k}=${n1(v)}`).join(', ')}
                  </option>
                ))}
              </select>
            </label>
          )}

          {g && (
            <dl className="facts small">
              <dt>Габарит</dt>
              <dd>
                {n0(g.width)} × {n0(g.height)} мм
              </dd>
              <dt>Площадь</dt>
              <dd>{n2(g.netArea / 1e6)} м²</dd>
              <dt>Длина реза</dt>
              <dd>{m(g.cutLength)}</dd>
              <dt>Врезок</dt>
              <dd>{g.pierces}</dd>
              <dt>Линий гиба</dt>
              <dd>{g.bends.length}</dd>
              {check && (
                <>
                  <dt>Масса по контуру</dt>
                  <dd>{kg(check.calc)}</dd>
                  <dt>Масса по чертежу</dt>
                  <dd className={`mass-${check.status}`}>
                    {check.drawing ? kg(check.drawing) : '—'}
                    {check.ratio ? ` (${check.ratio >= 1 ? '+' : ''}${n1((check.ratio - 1) * 100)}%)` : ''}
                  </dd>
                </>
              )}
            </dl>
          )}
          {check?.densityNote && <div className="small muted">{check.densityNote}</div>}
          {g && g.stretched.length > 0 && <div className="small muted">По таблице/размерам: {g.stretched.join(', ')}</div>}

          <footer className="dialog-f">
            <button className="btn" onClick={onClose}>
              Отмена
            </button>
            <button
              className="btn primary"
              disabled={!g}
              onClick={() => {
                onApply(meta);
                onClose();
              }}
            >
              Применить
            </button>
          </footer>
        </aside>
      </div>
    </div>
  );
}
