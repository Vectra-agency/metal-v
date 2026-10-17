// «Проверка чертежа»: страница PDF с найденными видами (синие), выбранный — оранжевый; щелчок по виду, масштаб
// и исполнение пересчитывают контур; «Применить» записывает геометрию с чертежа в позицию (порт PdfReview.tsx).
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { effectivePositions } from '@/ai/apply.ts';
import { Button } from '@/components/ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { X } from '@/components/common/icons.ts';
import { buildGeometry, STD_SCALES, type PdfMeta } from '@/core/pdfAnalyze.ts';
import { kg, m as meters, n0, n1, n2, NBSP } from '@/format.ts';
import { cn } from '@/lib/utils.ts';
import type { OrderPosition } from '@/order.ts';
import { geometryPatch, pdfCheck, reanalyze, renderPage, repick, type Reanalysis } from '@/pdfImport.ts';
import { closeDialog, editPosition } from '@/store/actions.ts';
import { useStore } from '@/store/store.ts';
import { massPct } from '@/components/positions/PdfBadge.tsx';
import { VIEW_WARN } from './PdfBlock.tsx';
import { scaleLabel, useRenderQueue } from './PdfDrawingView.tsx';

// выбранная страница — залита (как пресеты наценки)
const TOGGLE_ON = 'data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary/90';

const MASS_TONE = { ok: 'text-ok', warn: 'text-warn', bad: 'text-danger', unknown: '' } as const;

function Review({ base, pos }: { base: OrderPosition; pos: OrderPosition }): ReactElement {
  const pdf = base.pdf!;
  const [re, setRe] = useState<Reanalysis | null | undefined>(undefined); // undefined — разбирается, null — файла нет
  const [meta, setMeta] = useState<PdfMeta>(pdf.meta);
  const [cand, setCand] = useState(-1);
  const [page, setPage] = useState(pdf.meta.page);
  const [paper, setPaper] = useState<{ w: number; h: number } | null>(null);
  const [hover, setHover] = useState(-1);
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const queue = useRenderQueue();

  // повторный разбор файла: все найденные виды; какой из них выбран сейчас
  useEffect(() => {
    let alive = true;
    reanalyze(base)
      .then((r) => {
        if (!alive) return;
        setRe(r);
        if (r) {
          const b = pdf.meta.base.bbox;
          setCand(r.an.candidates.findIndex((c) => c.page === pdf.meta.page && Math.abs(c.bbox.minX - b.minX) < 0.05 && Math.abs(c.bbox.minY - b.minY) < 0.05));
        }
      })
      .catch(() => alive && setRe(null));
    return () => {
      alive = false;
    };
    // один раз на открытие (диалог пересоздаётся для каждой позиции)
  }, []);

  useEffect(() => {
    if (!canvas.current || !wrap.current) return;
    let alive = true;
    const c = canvas.current;
    const w = Math.min(1400, Math.max(320, wrap.current.clientWidth - 32));
    setPaper(null);
    queue(() => renderPage(pdf.fileKey, page, c, w))
      .then((r) => alive && setPaper(r))
      .catch(() => alive && setPaper(null));
    return () => {
      alive = false;
    };
  }, [pdf.fileKey, page]);

  const pages = useMemo(() => (re ? re.pages.map((x) => x.index) : [pdf.meta.page]), [re, pdf.meta.page]);
  const g = useMemo(() => (meta.base.outer.length ? buildGeometry(meta) : null), [meta]);
  const check = g ? pdfCheck({ ...pos, geom: { ...pos.geom, netArea: g.netArea }, pdf: { ...pdf, meta } }) : null;
  const scales = [...new Set([meta.scale, ...STD_SCALES])].sort((a, b) => a - b);

  const choose = (i: number, scale?: number) => {
    if (!re) return;
    setCand(i);
    setMeta(repick(re, { ...base, pdf: { ...pdf, meta } }, i, scale));
  };
  const apply = () => {
    editPosition(base.id, {
      ...geometryPatch(meta, base),
      source: 'pdf',
      pdf: { ...pdf, meta, geometryFromPdf: true },
      warnings: base.warnings.filter((w) => !VIEW_WARN.test(w)),
    });
    closeDialog();
  };

  return (
    <>
      {/* слева — чертёж */}
      <div className="flex min-h-0 min-w-0 flex-col bg-muted/40">
        <div ref={wrap} className="relative min-h-0 flex-1 overflow-auto p-4">
          {re === null && (
            <p className="mb-3 rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">Файл PDF не сохранён в браузере — перетащите его ещё раз, чтобы открыть чертёж.</p>
          )}
          <div className="relative mx-auto w-fit bg-white shadow-sm">
            <canvas ref={canvas} className="block" />
            {!paper && re !== null && <Skeleton className="absolute inset-0 min-h-64 min-w-80 rounded-none" />}
            {paper && re && (
              <svg viewBox={`0 0 ${paper.w} ${paper.h}`} className="absolute inset-0 size-full" role="group" aria-label="Найденные виды">
                <g transform={`matrix(1 0 0 -1 0 ${paper.h})`}>
                  {re.an.candidates.map((c, i) =>
                    c.page !== page ? null : (
                      <path
                        key={i}
                        d={'M' + c.part.outer.pts.map((v) => `${v.x} ${v.y}`).join('L') + 'Z'}
                        role="button"
                        tabIndex={0}
                        aria-label={`Вид ${i + 1}${i === cand ? ' (выбран)' : ''}: считать по нему`}
                        aria-pressed={i === cand}
                        className={cn(
                          'cursor-pointer outline-none',
                          i === cand ? 'fill-cut/25 stroke-cut' : i === hover ? 'fill-metal/25 stroke-metal' : 'fill-metal/10 stroke-metal',
                          'focus-visible:stroke-ring',
                        )}
                        strokeWidth={i === cand ? 2 : 1.5}
                        vectorEffect="non-scaling-stroke"
                        onMouseEnter={() => setHover(i)}
                        onMouseLeave={() => setHover(-1)}
                        onClick={() => choose(i)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            choose(i);
                          }
                        }}
                      >
                        <title>Вид {i + 1}: щёлкните, чтобы считать по нему</title>
                      </path>
                    ),
                  )}
                </g>
              </svg>
            )}
          </div>
        </div>
        {pages.length > 1 && (
          <div className="flex items-center gap-2 border-t bg-background px-4 py-2">
            <ToggleGroup type="single" size="sm" variant="outline" value={String(page)} onValueChange={(v) => v && setPage(Number(v))} aria-label="Страница">
              {pages.map((i) => (
                <ToggleGroupItem key={i} value={String(i)} className={TOGGLE_ON}>
                  стр. {i + 1}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        )}
      </div>

      {/* справа — выбор и факты */}
      <aside className="flex min-h-0 flex-col border-l max-md:border-t max-md:border-l-0">
        <div className="flex items-start gap-2 border-b px-4 py-3">
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-base font-semibold">Проверка чертежа</DialogTitle>
            <DialogDescription className="truncate text-xs" title={pdf.meta.fileName}>
              {pdf.meta.fileName}
            </DialogDescription>
          </div>
          <Button size="icon-sm" variant="ghost" aria-label="Закрыть" onClick={closeDialog}>
            <X />
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3 text-sm">
          <p>
            Синим обведены найденные виды, выбранный — залит оранжевым. Если программа взяла не тот вид, щёлкните нужный на чертеже.
          </p>
          {re === undefined && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Spinner /> Ищу виды на чертеже…
            </p>
          )}
          {!pdf.geometryFromPdf && (
            <p className="rounded-md bg-muted px-3 py-2 text-xs">Сейчас контур взят из DXF. «Применить» заменит его контуром с чертежа.</p>
          )}

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground" htmlFor="review-scale">
              Масштаб вида
            </label>
            <Select value={String(meta.scale)} onValueChange={(v) => cand >= 0 && choose(cand, Number(v))} disabled={cand < 0}>
              <SelectTrigger id="review-scale" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {scales.map((s) => (
                  <SelectItem key={s} value={String(s)}>
                    {scaleLabel(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{meta.scaleWhy}</p>
          </div>

          {meta.table && meta.table.rows.length > 0 && (
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground" htmlFor="review-row">
                Исполнение
              </label>
              <Select value={String(meta.row)} onValueChange={(v) => setMeta({ ...meta, row: Number(v) })}>
                <SelectTrigger id="review-row" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  <SelectItem value="-1">как нарисовано</SelectItem>
                  {meta.table.rows.map((r, i) => (
                    <SelectItem key={i} value={String(i)}>
                      {r.designation} —{' '}
                      {Object.entries(r.values)
                        .map(([k, v]) => `${k === 'mass' ? 'масса' : k}=${n1(v)}`)
                        .join(', ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {g ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 tabular-nums">
              <dt className="text-muted-foreground">Габарит</dt>
              <dd>
                {n0(g.width)} × {n0(g.height)}
                {NBSP}мм
              </dd>
              <dt className="text-muted-foreground">Площадь</dt>
              <dd>
                {n2(g.netArea / 1e6)}
                {NBSP}м²
              </dd>
              <dt className="text-muted-foreground">Длина реза</dt>
              <dd>{meters(g.cutLength)}</dd>
              <dt className="text-muted-foreground">Врезок</dt>
              <dd>{g.pierces}</dd>
              <dt className="text-muted-foreground">Линий гиба</dt>
              <dd>{g.bends.length}</dd>
              {check && (
                <>
                  <dt className="text-muted-foreground">Масса по контуру</dt>
                  <dd>{kg(check.calc)}</dd>
                  <dt className="text-muted-foreground">Масса по чертежу</dt>
                  <dd className={MASS_TONE[check.status]}>
                    {check.drawing ? kg(check.drawing) : '—'}
                    {check.ratio ? ` (${massPct(check.ratio)})` : ''}
                  </dd>
                </>
              )}
            </dl>
          ) : (
            re !== undefined && <p className="text-muted-foreground">Вид не выбран — щёлкните деталь на чертеже.</p>
          )}
          {check?.densityNote && <p className="text-xs text-muted-foreground">{check.densityNote}</p>}
          {g && g.stretched.length > 0 && <p className="text-xs text-muted-foreground">По таблице/размерам: {g.stretched.join(', ')}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t px-4 py-3">
          <Button variant="outline" onClick={closeDialog}>
            Отмена
          </Button>
          <Button disabled={!g} onClick={apply}>
            Применить
          </Button>
        </div>
      </aside>
    </>
  );
}

export function PdfReviewDialog(): ReactElement | null {
  const id = useStore((s) => (s.ui.dialog?.kind === 'pdfReview' ? s.ui.dialog.id : null));
  const base = useStore((s) => (id ? s.order.positions.find((p) => p.id === id) : undefined));
  const ai = useStore((s) => s.order.ai);
  const pos = useMemo(() => (base ? effectivePositions([base], ai)[0] : undefined), [base, ai]);
  if (!id || !base?.pdf || !pos) return null;
  return (
    <Dialog open onOpenChange={(o) => !o && closeDialog()}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          'grid h-[92dvh] max-w-[min(1280px,96vw)] grid-cols-[1fr_340px] gap-0 overflow-hidden p-0 sm:max-w-[min(1280px,96vw)]',
          'max-md:grid-cols-1 max-md:grid-rows-[minmax(0,1fr)_minmax(0,45%)]',
        )}
      >
        <Review key={id} base={base} pos={pos} />
      </DialogContent>
    </Dialog>
  );
}
