// Чертёж в карточке: страница PDF (canvas) и поверх — контур выбранного вида (оранжевым). Щелчок — «Проверка чертежа».
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { ZoomIn } from 'lucide-react';
import type { OrderPosition } from '@/order.ts';
import { renderPage } from '@/pdfImport.ts';
import { openDialog } from '@/store/actions.ts';

/** «1:2», «2:1» */
export const scaleLabel = (s: number) => (s >= 1 ? `1:${String(s).replace('.', ',')}` : `${String(1 / s).replace('.', ',')}:1`);

/** Плоский массив x0,y0,x1,y1… → путь SVG */
export const flatPath = (a: number[]) => {
  if (a.length < 4) return '';
  let d = `M${a[0]} ${a[1]}`;
  for (let i = 2; i + 1 < a.length; i += 2) d += `L${a[i]} ${a[i + 1]}`;
  return d + 'Z';
};

/** Отрисовки страниц в один canvas — по очереди (pdf.js не рисует в один canvas дважды одновременно) */
export function useRenderQueue() {
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  return <T,>(job: () => Promise<T>): Promise<T> => {
    const next = chain.current.then(job, job);
    chain.current = next.catch(() => undefined);
    return next;
  };
}

export function PdfDrawingView({ p }: { p: OrderPosition }): ReactElement | null {
  const pdf = p.pdf;
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [paper, setPaper] = useState<{ w: number; h: number } | null | undefined>(undefined); // undefined — рисуется
  const queue = useRenderQueue();
  const fileKey = pdf?.fileKey;
  const page = pdf?.meta.page ?? 0;

  useEffect(() => {
    if (!fileKey || !canvas.current || !wrap.current) return;
    let alive = true;
    setPaper(undefined);
    const width = Math.max(240, Math.floor(wrap.current.clientWidth));
    const c = canvas.current;
    queue(() => renderPage(fileKey, page, c, width))
      .then((r) => alive && setPaper(r))
      .catch(() => alive && setPaper(null));
    return () => {
      alive = false;
    };
  }, [fileKey, page]);

  if (!pdf) return null;
  const meta = pdf.meta;
  const outer = meta.base.outer;
  const scan = !outer.length;
  const open = () => openDialog({ kind: 'pdfReview', id: p.id });
  return (
    <figure className="space-y-1.5">
      <div ref={wrap} className="relative w-full overflow-hidden rounded-md border bg-white">
        {paper === null ? (
          <p className="bg-muted p-6 text-center text-sm text-muted-foreground">Файл PDF не сохранён в браузере — перетащите его ещё раз</p>
        ) : scan ? (
          // скан: видов для выбора нет — только картинка (по ней удобно снять размеры для «Габарит вручную»)
          <div className="relative">
            <canvas ref={canvas} className="block max-w-full" />
            {paper === undefined && <Skeleton className="absolute inset-0 rounded-none" />}
          </div>
        ) : (
          <button
            type="button"
            onClick={open}
            disabled={paper === undefined}
            aria-label="Открыть чертёж и проверить вид и масштаб"
            className="focus-ring group/pdf relative block w-full cursor-zoom-in"
          >
            <canvas ref={canvas} className="block max-w-full" />
            {paper === undefined && <Skeleton className="absolute inset-0 rounded-none" />}
            {paper && outer.length > 0 && (
              <svg viewBox={`0 0 ${paper.w} ${paper.h}`} className="pointer-events-none absolute inset-0 size-full" aria-hidden>
                <g transform={`matrix(1 0 0 -1 0 ${paper.h})`}>
                  <path
                    d={flatPath(outer) + meta.base.holes.map(flatPath).join('')}
                    className="fill-cut/15 stroke-cut"
                    fillRule="evenodd"
                    strokeWidth={1.6}
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              </svg>
            )}
            <span className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-md bg-background/90 px-1.5 py-0.5 text-xs text-foreground opacity-0 shadow-sm transition-opacity group-hover/pdf:opacity-100 group-focus-visible/pdf:opacity-100">
              <ZoomIn aria-hidden className="size-3.5" />
              Проверить вид
            </span>
          </button>
        )}
      </div>
      <figcaption className="text-xs text-muted-foreground">
        {scan ? (
          <>
            стр. {meta.page + 1} · скан: {p.geom.netArea > 0 ? 'габарит задан вручную' : 'размеры не распознать — задайте габарит вручную'}
          </>
        ) : (
          <>
            стр. {meta.page + 1} · М {scaleLabel(meta.scale)} ({meta.scaleWhy})
          </>
        )}
      </figcaption>
    </figure>
  );
}
