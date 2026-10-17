// Список этапов расчёта (ui-spec §2.5): значок · этап · подробности · время. Один и тот же — на экране обработки
// и в «Заявка и документы» → «Ход расчёта» (там с кнопками: обновить цены, отменить / запустить анализ ИИ).
// Итог «Расчёта» — живой (по текущим числам, не снимок конца запуска). До запуска в этой вкладке (заказ после
// перезагрузки или «Вернуть») этапы выводятся из состояния, как пилюли в шапке (ui-spec §2.2.1).
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { cn } from '@/lib/utils.ts';
import { Button } from '@/components/ui/button.tsx';
import { Progress } from '@/components/ui/progress.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { Circle, CircleCheck, CircleMinus, CircleX, RefreshCw, Sparkles } from '@/components/common/icons.ts';
import { dateDay, dateShort, hhmm, n1, plural, thick } from '@/format.ts';
import { calcDetail, STAGE_ORDER, type Stage, type StageId, type Stages, type StageStatus } from '@/pipeline.ts';
import { pairAge, pairFetchedAt } from '@/prices.ts';
import { closeSheet, setTab } from '@/store/actions.ts';
import { useDerived } from '@/store/derived.tsx';
import { cancelAnalysis, jobDetail, readyText, refreshPrices, runAnalysis, shortModel } from '@/store/pipelineActions.ts';
import { useStore } from '@/store/store.ts';

/** Текущее время, обновляется раз в ms, пока active (секундомер анализа ИИ) */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return active ? now : Date.now();
}

/** Кнопка «Обновить цены»: недоступна без сервера, без позиций, во время обновления и 15 мин после «я не робот» */
export function usePriceRefresh(): { disabled: boolean; busy: string | null; note: string | null } {
  const live = useStore((s) => s.prices.live);
  const loaded = useStore((s) => s.prices.loaded);
  const busy = useStore((s) => s.prices.busy);
  const stageRunning = useStore((s) => s.pipeline.stages.prices.status === 'running');
  const blockedUntil = useStore((s) => s.prices.blockedUntil);
  const hasPositions = useStore((s) => s.order.positions.length > 0);
  const now = useNow(!!blockedUntil && blockedUntil > Date.now(), 15_000);
  const blocked = !!blockedUntil && blockedUntil > now;
  const disabled = !loaded || !live || !hasPositions || !!busy || stageRunning || blocked;
  const note = blocked ? `Можно повторить в ${hhmm(blockedUntil)}` : null;
  return { disabled, busy: busy ?? (stageRunning ? 'Проверяю свежесть цен…' : null), note };
}

const STATUS_WORD: Record<StageStatus, string> = { pending: 'ожидает', running: 'идёт', done: 'готово', skipped: 'пропущено', error: 'ошибка' };

export function StageIcon({ status, className }: { status: StageStatus; className?: string }): ReactElement {
  const cls = cn('size-4 shrink-0', className);
  if (status === 'running') return <Spinner aria-hidden className={cls} role="presentation" aria-label={undefined} />;
  if (status === 'done') return <CircleCheck aria-hidden className={cn(cls, 'text-ok')} />;
  if (status === 'skipped') return <CircleMinus aria-hidden className={cn(cls, 'text-muted-foreground')} />;
  if (status === 'error') return <CircleX aria-hidden className={cn(cls, 'text-danger')} />;
  return <Circle aria-hidden className={cn(cls, 'text-muted-foreground/60')} />;
}

/** «1,8 с» — только для завершённых этапов */
function duration(s: Stage): string | null {
  if (s.status === 'pending' || s.status === 'running' || s.startedAt == null || s.finishedAt == null) return null;
  const sec = (s.finishedAt - s.startedAt) / 1000;
  return sec >= 0.05 ? `${n1(sec)} с` : null;
}

/** Подробности этапа: для идущих — живые (прогресс чтения, отправка чертежей, секундомер ИИ) */
function Detail({ stage }: { stage: Stage }): ReactElement {
  const parse = useStore((s) => s.pipeline.parse);
  const run = useStore((s) => s.ai.run);
  const model = useStore((s) => s.ai.server?.model ?? null);
  const aiRunning = stage.id === 'ai' && stage.status === 'running' && !!run;
  const now = useNow(aiRunning);
  if (stage.id === 'files' && stage.status === 'running' && parse && parse.total > 0) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="truncate">{parse.done ? `Читаю ${parse.done} из ${parse.total}: ${parse.file}` : 'Читаю файлы…'}</span>
        <Progress value={(parse.done / parse.total) * 100} aria-label="Чтение файлов" className="h-1.5" />
      </div>
    );
  }
  if (aiRunning && run) {
    const job = run.job;
    return (
      <div className="flex flex-col gap-1.5">
        <span>{jobDetail(job, run.startedAt, model, now)}</span>
        {job?.status === 'waiting' && job.imagesExpected > 0 && (
          <Progress value={(job.imagesReceived / job.imagesExpected) * 100} aria-label="Отправка чертежей" className="h-1.5" />
        )}
      </div>
    );
  }
  return <span className={cn(stage.status === 'error' && 'text-danger')}>{stage.detail || (stage.status === 'pending' ? 'Ожидает' : '')}</span>;
}

function PricesActions(): ReactElement {
  const r = usePriceRefresh();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button variant="outline" size="xs" disabled={r.disabled} onClick={() => void refreshPrices()}>
        {r.busy ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
        Обновить цены
      </Button>
      <Button
        variant="link"
        size="xs"
        className="px-0 text-muted-foreground underline hover:text-foreground"
        onClick={() => {
          setTab('prices');
          closeSheet();
        }}
      >
        Открыть вкладку «Цены mc.ru»
      </Button>
      {r.note && <span className="text-xs text-muted-foreground">{r.note}</span>}
    </div>
  );
}

function AiActions(): ReactElement | null {
  const running = useStore((s) => !!s.ai.run || s.pipeline.stages.ai.status === 'running');
  const outcome = useStore((s) => s.ai.outcome.kind);
  const hasAi = useStore((s) => !!s.order.ai);
  const configured = useStore((s) => !!s.ai.server?.configured);
  const busy = useStore((s) => s.pipeline.busy);
  const hasPositions = useStore((s) => s.order.positions.length > 0);
  const { outdated } = useDerived();
  if (running) {
    return (
      <Button variant="ghost" size="xs" onClick={cancelAnalysis}>
        Отменить анализ
      </Button>
    );
  }
  if (!configured || !hasPositions) return null;
  const label = outcome === 'error' ? 'Повторить' : hasAi && outdated ? 'Обновить анализ ИИ' : !hasAi ? 'Запустить анализ ИИ' : null;
  if (!label) return null;
  return (
    <Button variant="outline" size="xs" disabled={busy} onClick={() => void runAnalysis()}>
      {label === 'Повторить' ? <RefreshCw data-icon="inline-start" /> : <Sparkles data-icon="inline-start" />}
      {label}
    </Button>
  );
}

const ACTIONS: Partial<Record<StageId, () => ReactElement | null>> = { prices: PricesActions, ai: AiActions };

/** «16.10» */
const ddmm = (w: string | number | null | undefined) => (w ? dateDay(w).slice(0, 5) : '—');

/** Этапы для списка: итог расчёта — по текущим числам; до запуска в этой вкладке — из состояния заказа */
function useStageRows(): Stages {
  const stages = useStore((s) => s.pipeline.stages);
  const busy = useStore((s) => s.pipeline.busy || s.pipeline.processing);
  const n = useStore((s) => s.order.positions.length);
  const docs = useStore((s) => s.order.documents?.length ?? 0);
  const loaded = useStore((s) => s.prices.loaded);
  const live = useStore((s) => s.prices.live);
  const book = useStore((s) => s.prices.book);
  const issue = useStore((s) => s.prices.issue);
  const maxAge = useStore((s) => s.settings.priceMaxAgeHours ?? 24);
  const ai = useStore((s) => s.order.ai);
  const outcome = useStore((s) => s.ai.outcome);
  const server = useStore((s) => s.ai.server);
  const pending = useStore((s) => s.ai.pending);
  const d = useDerived();
  return useMemo(() => {
    const calc = calcDetail(d.res, d.quote);
    const fresh = n > 0 && !busy && STAGE_ORDER.every((id) => stages[id].status === 'pending');
    if (!fresh) return stages.calc.status === 'done' ? { ...stages, calc: { ...stages.calc, detail: calc } } : stages;
    const row = (id: StageId, status: StageStatus, detail: string): Stage => ({ id, label: stages[id].label, status, detail });

    let files = `${n} ${plural(n, 'позиция', 'позиции', 'позиций')}`;
    if (docs) files += `, ${docs} ${plural(docs, 'документ', 'документа', 'документов')}`;

    let prices: Stage;
    if (!loaded) prices = row('prices', 'running', 'Загрузка цен…');
    else if (!live) prices = row('prices', 'skipped', `Цены из снимка от ${ddmm(book.updatedAt)} — статическая версия, обновление недоступно`);
    else {
      // самая старая дата получения среди пар заказа; оценки и устаревшие цены — повод проверить (как пилюля «Цены»)
      let oldest: string | null = null;
      const estimate: string[] = [];
      const old: string[] = [];
      for (const g of d.res.groups) {
        const label = `${g.material.short} ${thick(g.t)}`;
        if (g.chosen.offer.source === 'estimate') estimate.push(label);
        const at = pairFetchedAt(book, g.material.id, g.t);
        if (at && (!oldest || at < oldest)) oldest = at;
        if (g.chosen.offer.source === 'mc' && pairAge(book, g.material.id, g.t) > maxAge) old.push(label);
      }
      const parts = [`Цены mc.ru от ${ddmm(oldest ?? book.updatedAt)}`];
      if (issue) parts.push(issue.reason);
      if (estimate.length) parts.push(`нет нужной толщины на mc.ru, цена оценена: ${estimate.join(', ')}`);
      if (old.length) parts.push(`старше ${maxAge} ч: ${old.join(', ')}`);
      prices = row('prices', 'done', parts.join(' · '));
    }

    let aiRow: Stage;
    if (pending) aiRow = row('ai', 'done', `${readyText(pending.analysis)} — результат ещё не применён`);
    else if (outcome.kind === 'error') aiRow = row('ai', 'error', outcome.message);
    else if (ai) {
      const a = ai.analysis;
      aiRow = row('ai', 'done', `${shortModel(a.model)} · ${dateShort(a.createdAt)}${d.outdated ? ' · устарел: заказ изменился после анализа' : ''}`);
    } else {
      const why =
        outcome.kind === 'skipped'
          ? outcome.reason
          : outcome.kind === 'cancelled'
            ? 'анализ отменён'
            : server && !server.configured
              ? 'ИИ не подключён на сервере'
              : 'анализ не выполнялся';
      aiRow = row('ai', 'skipped', `Без ИИ — ${why}`);
    }

    return { files: row('files', 'done', files), prices, ai: aiRow, calc: row('calc', 'done', calc) };
  }, [stages, busy, n, docs, loaded, live, book, issue, maxAge, ai, outcome, server, pending, d.res, d.quote, d.outdated]);
}

export function StageList({ actions = false, className }: { actions?: boolean; className?: string }): ReactElement {
  const stages = useStageRows();
  return (
    <ol aria-live="polite" aria-label="Этапы расчёта" className={cn('divide-y', className)}>
      {STAGE_ORDER.map((id) => {
        const st = stages[id];
        const time = duration(st);
        const Actions = actions ? ACTIONS[id] : undefined;
        return (
          <li
            key={id}
            data-stage={id}
            data-status={st.status}
            className="grid grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 py-2 sm:grid-cols-[20px_150px_minmax(0,1fr)_auto]"
          >
            <span className="flex h-5 items-center">
              <StageIcon status={st.status} />
            </span>
            <span className={cn('leading-5 font-medium', st.status === 'pending' && 'text-muted-foreground')}>
              {st.label}
              <span className="sr-only">: {STATUS_WORD[st.status]}</span>
            </span>
            <div className="col-start-2 row-start-2 min-w-0 leading-5 text-muted-foreground sm:col-start-3 sm:row-start-1">
              <Detail stage={st} />
              {Actions && (
                <div className="mt-1.5">
                  <Actions />
                </div>
              )}
            </div>
            <span className="col-start-3 row-start-1 text-xs leading-5 whitespace-nowrap text-muted-foreground tabular-nums sm:col-start-4">{time}</span>
          </li>
        );
      })}
    </ol>
  );
}
