// Экран обработки первого запуска (ui-spec §2.5): чтение файлов и цены mc.ru с подробностями и временем, позиции,
// предварительная цена. Сразу после цен открывается расчёт, анализ ИИ идёт в фоне (его ход и заявка — в карточке ИИ);
// «Показать расчёт сейчас» — не дожидаясь обновления цен.
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.tsx';
import { getMaterial } from '@/core/materials.ts';
import { n0, n1, NBSP, plural } from '@/format.ts';
import type { OrderPosition } from '@/order.ts';
import type { StageStatus } from '@/pipeline.ts';
import { useDerived } from '@/store/derived.tsx';
import { showResultNow } from '@/store/pipelineActions.ts';
import { useStore } from '@/store/store.ts';
import { StageList } from './StageList.tsx';

const SHOWN = 6;
const final = (s: StageStatus) => s === 'done' || s === 'skipped' || s === 'error';

function Guess({ on }: { on: boolean }): ReactElement | null {
  if (!on) return null;
  return (
    <span className="font-medium text-guessed" title="не найдено в файле">
      ?<span className="sr-only"> (не найдено в файле)</span>
    </span>
  );
}

function PositionLine({ p }: { p: OrderPosition }): ReactElement {
  const m = getMaterial(p.materialId);
  return (
    <li className="truncate">
      <span className="text-foreground">{p.name}</span> · {m.short}
      <Guess on={p.guessed.material} /> {n1(p.thickness)}
      {NBSP}мм
      <Guess on={p.guessed.thickness} /> · {p.qty}
      {NBSP}шт
      <Guess on={p.guessed.qty} />
    </li>
  );
}

/** «Предварительно, до проверки ИИ: ≈ 189 700 ₽ клиенту · 7 поз. · 25 шт» и первые позиции */
function Preliminary(): ReactElement | null {
  const filesDone = useStore((s) => final(s.pipeline.stages.files.status));
  const pricesDone = useStore((s) => final(s.pipeline.stages.prices.status));
  const d = useDerived();
  if (!filesDone || !d.positions.length) return null;
  const active = d.positions.filter((p) => !p.disabled);
  const rest = d.positions.length - SHOWN;
  const total = Math.round(d.quote.total / 100) * 100;
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-muted/50 p-3">
      {pricesDone ? (
        <p>
          Предварительно, до проверки ИИ:{' '}
          <span className="font-semibold whitespace-nowrap text-foreground tabular-nums">
            ≈{NBSP}
            {n0(total)}
            {NBSP}₽
          </span>{' '}
          клиенту · {active.length}
          {NBSP}поз. · {n0(d.res.totals.pieces)}
          {NBSP}шт
        </p>
      ) : (
        <p className="text-muted-foreground">Предварительная цена появится после обновления цен</p>
      )}
      <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground" aria-label="Позиции заказа">
        {d.positions.slice(0, SHOWN).map((p) => (
          <PositionLine key={p.id} p={p} />
        ))}
        {rest > 0 && (
          <li>
            … ещё {rest} {plural(rest, 'позиция', 'позиции', 'позиций')}
          </li>
        )}
      </ul>
    </div>
  );
}

/** Цены ещё обновляются — можно не ждать; про ИИ — что он не задержит расчёт */
function Actions(): ReactElement | null {
  const filesDone = useStore((s) => final(s.pipeline.stages.files.status));
  const pricesRunning = useStore((s) => s.pipeline.stages.prices.status === 'running');
  const ai = useStore((s) => !!s.ai.server?.configured);
  if (!filesDone) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-4">
      {pricesRunning && (
        <>
          <Button variant="outline" onClick={showResultNow}>
            Показать расчёт сейчас
          </Button>
          <span className="text-xs text-muted-foreground">цены mc.ru обновятся в фоне</span>
        </>
      )}
      {ai && <span className="text-xs text-muted-foreground sm:ml-auto">Анализ ИИ пойдёт в фоне — расчёт откроется сразу после цен</span>}
    </div>
  );
}

export function ProcessingScreen(): ReactElement {
  const title = useStore((s) => s.order.title.trim());
  return (
    <Card className="mx-auto mt-4 w-full max-w-180 lg:mt-10">
      <CardHeader>
        <CardTitle>{title ? `Расчёт заказа «${title}»` : 'Расчёт заказа'}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <StageList />
        <Preliminary />
        <Actions />
      </CardContent>
    </Card>
  );
}
