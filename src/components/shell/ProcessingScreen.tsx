// Экран обработки первого запуска (ui-spec §2.5): 4 этапа с подробностями и временем, предварительная цена после
// цен mc.ru, «Показать расчёт без ИИ» (анализ продолжается в фоне), «Отменить анализ», поле заявки, если её нет.
import { useEffect, useState, type ReactElement } from 'react';
import { cn } from '@/lib/utils.ts';
import { Button } from '@/components/ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { getMaterial } from '@/core/materials.ts';
import { n0, n1, NBSP, plural } from '@/format.ts';
import type { OrderPosition } from '@/order.ts';
import type { StageStatus } from '@/pipeline.ts';
import { useDerived } from '@/store/derived.tsx';
import { cancelAnalysis, setRequest, showResultNow } from '@/store/pipelineActions.ts';
import { useStore } from '@/store/store.ts';
import { RequestCounter } from './EmptyScreen.tsx';
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

/** Заявки нет — поле прямо здесь; вставка во время анализа перезапускает его один раз */
function NoRequest(): ReactElement | null {
  const configured = useStore((s) => !!s.ai.server?.configured);
  const filesDone = useStore((s) => final(s.pipeline.stages.files.status));
  const none = useStore((s) => !(s.order.request ?? '').trim() && !(s.order.documents ?? []).length && !(s.order.requestLines ?? []).length);
  const request = useStore((s) => s.order.request ?? '');
  const run = useStore((s) => s.ai.run);
  // однажды показанное поле не исчезает, когда в нём появился текст
  const [sticky, setSticky] = useState(false);
  const want = filesDone && none;
  const pastedDuringRun = !!run && !run.requestAtStart.trim() && !!request.trim();
  useEffect(() => {
    if (want || pastedDuringRun) setSticky(true);
  }, [want, pastedDuringRun]);
  if (!configured || !(want || sticky || pastedDuringRun)) return null;
  const hint = run?.restarted ? 'Заявка добавлена — анализ перезапущен' : run && run.requestAtStart.trim() ? null : 'Анализ начнётся заново с заявкой';
  const filled = !!request.trim();
  return (
    <div className={cn('flex flex-col gap-2 rounded-lg border p-3', filled ? 'bg-muted/40' : 'border-warn/40 bg-warn-soft')}>
      <label htmlFor="request-input" className="font-medium">
        {filled ? 'Заявка клиента' : 'Заявки нет — вставьте текст письма, ИИ сверит количество'}
      </label>
      <Textarea
        id="request-input"
        value={request}
        onChange={(e) => setRequest(e.target.value)}
        placeholder="Вставьте текст письма: «Прошу счёт… БВС-305Х300.000 — 3 шт»"
        className="max-h-[40dvh] min-h-24 resize-y overflow-y-auto bg-background"
        spellCheck={false}
      />
      <div className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
        <span aria-live="polite">{hint}</span>
        <RequestCounter len={request.length} />
      </div>
    </div>
  );
}

function Actions(): ReactElement | null {
  const pricesStarted = useStore((s) => s.pipeline.stages.prices.status !== 'pending');
  const aiRunning = useStore((s) => s.pipeline.stages.ai.status === 'running');
  if (!pricesStarted) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-4">
      <Button variant="outline" onClick={showResultNow}>
        Показать расчёт без ИИ
      </Button>
      <span className="text-xs text-muted-foreground">анализ продолжится в фоне</span>
      {aiRunning && (
        <Button variant="ghost" className="ml-auto" onClick={cancelAnalysis}>
          Отменить анализ
        </Button>
      )}
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
        <NoRequest />
        <Actions />
      </CardContent>
    </Card>
  );
}
