// «Чертёж» в карточке: страница PDF с выбранным видом / контур детали (что ушло в расчёт) / текст чертежа для ИИ.
import { useEffect, useState, type ReactElement } from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { PartPreview } from '@/components/common/PartPreview.tsx';
import { m as meters, n2 } from '@/format.ts';
import { listFileKeys } from '@/idb.ts';
import type { OrderPosition } from '@/order.ts';
import { useStore } from '@/store/store.ts';
import { PdfDrawingView } from './PdfDrawingView.tsx';

type View = 'drawing' | 'contour' | 'text';

// выбранный вид — залит (как пресеты наценки): обычный bg-muted почти не виден в тёмной теме
const TOGGLE_ON = 'data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary/90';

/** Есть ли файл PDF в браузере (IndexedDB); null — ещё проверяется */
function useHasFile(fileKey: string | undefined): boolean | null {
  const [has, setHas] = useState<{ key: string; v: boolean } | null>(null);
  useEffect(() => {
    if (!fileKey) return;
    let alive = true;
    listFileKeys()
      .then((keys) => alive && setHas({ key: fileKey, v: keys.includes(fileKey) }))
      .catch(() => alive && setHas({ key: fileKey, v: false }));
    return () => {
      alive = false;
    };
  }, [fileKey]);
  if (!fileKey) return false;
  return has?.key === fileKey ? has.v : null;
}

function Legend(): ReactElement {
  const item = 'inline-flex items-center gap-1.5';
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span className={item}>
        <svg aria-hidden className="h-2.5 w-4" viewBox="0 0 16 10">
          <rect x="1" y="1" width="14" height="8" className="fill-metal/15 stroke-metal" strokeWidth="1.5" />
        </svg>
        контур детали
      </span>
      <span className={item}>
        <svg aria-hidden className="h-2.5 w-4" viewBox="0 0 16 10">
          <line x1="0" y1="5" x2="16" y2="5" className="stroke-bend" strokeWidth="2" strokeDasharray="4 3" />
        </svg>
        линия гиба
      </span>
      <span className={item}>
        <svg aria-hidden className="h-2.5 w-4" viewBox="0 0 16 10">
          <line x1="0" y1="5" x2="16" y2="5" className="stroke-muted-foreground" strokeWidth="1.2" strokeDasharray="2 2" />
        </svg>
        не в расчёте (рамка, обрывки)
      </span>
    </div>
  );
}

function Contour({ p }: { p: OrderPosition }): ReactElement {
  const g = p.geom;
  const facts: [string, string][] = [
    ['Площадь детали', `${n2(g.netArea / 1e6)} м²`],
    ['Габаритная площадь', `${n2(g.bboxArea / 1e6)} м²`],
    ['Длина реза', meters(g.cutLength)],
    ['Врезок (контуров)', String(g.pierces)],
  ];
  if (g.count > 1) facts.push(['Деталей в файле', String(g.count)]);
  const has = g.netArea > 0; // скан без габарита — только «нет контура»
  return (
    <div className="space-y-2">
      <PartPreview preview={p.preview} size="large" showIgnored dims={g.width > 0 ? { w: g.width, h: g.height } : undefined} />
      {has && <Legend />}
      {has && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm">
          {facts.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function DrawingText({ p }: { p: OrderPosition }): ReactElement {
  const sent = useStore((s) => s.ai.lastContext?.positions.find((x) => x.id === p.id)?.drawingText);
  const text = sent ?? p.drawingText ?? '';
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">{sent != null ? 'Этот текст получил ИИ' : 'Текст, который уйдёт в анализ (не больше 1 500 символов)'}</p>
      {text.trim() ? (
        <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap">{text}</pre>
      ) : (
        <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">Текста на чертеже не найдено (скан или DXF без надписей)</p>
      )}
    </div>
  );
}

// выбор запоминается до перезагрузки: ↑/↓ по позициям не сбрасывают, например, «Текст чертежа»
let lastView: View | null = null;

export function DrawingSection({ p }: { p: OrderPosition }): ReactElement {
  const hasFile = useHasFile(p.pdf?.fileKey);
  const [chosen, setChosen] = useState<View | null>(lastView);
  // по умолчанию — чертёж, если PDF есть в браузере; пока не ясно — контур
  const auto: View = p.pdf && hasFile ? 'drawing' : 'contour';
  const view: View = chosen === 'drawing' && !p.pdf ? auto : (chosen ?? auto);
  const choose = (v: View) => {
    lastView = v;
    setChosen(v);
  };
  return (
    <section aria-labelledby="drawing-h" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="drawing-h" className="text-sm font-semibold">
          Чертёж
        </h3>
        <ToggleGroup type="single" size="sm" variant="outline" value={view} onValueChange={(v) => v && choose(v as View)} aria-label="Что показать">
          {p.pdf && (
            <ToggleGroupItem value="drawing" className={TOGGLE_ON}>
              Чертёж
            </ToggleGroupItem>
          )}
          <ToggleGroupItem value="contour" className={TOGGLE_ON}>
            Контур
          </ToggleGroupItem>
          <ToggleGroupItem value="text" className={TOGGLE_ON}>
            Текст чертежа
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {view === 'drawing' && p.pdf ? <PdfDrawingView p={p} /> : view === 'text' ? <DrawingText p={p} /> : <Contour p={p} />}
    </section>
  );
}
