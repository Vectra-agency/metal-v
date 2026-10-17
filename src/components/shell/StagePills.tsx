// Этапы в шапке (ui-spec §2.2.1): «Файлы», «Цены», «ИИ» — значок + слово или число. Во время запуска — по этапам,
// до запуска (заказ из прошлой сессии) — по состоянию: позиции, справочник цен, анализ в заказе.
// Нажатие открывает «Заявка и документы» на нужном разделе.
import type { ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/utils.ts';
import { Button } from '@/components/ui/button.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { CircleCheck, CircleMinus, CircleX, History, Sparkles, TriangleAlert } from '@/components/common/icons.ts';
import { dateDay, elapsed, plural, thick } from '@/format.ts';
import { STAGE_LABEL, type StageId } from '@/pipeline.ts';
import { pairAge, pairFetchedAt } from '@/prices.ts';
import { openSheet } from '@/store/actions.ts';
import { useDerived } from '@/store/derived.tsx';
import { jobDetail, readyText, shortModel } from '@/store/pipelineActions.ts';
import { useStore } from '@/store/store.ts';
import type { AppState, RequestSection } from '@/store/types.ts';
import { useNow } from './StageList.tsx';

/** «16.10» */
const ddmm = (w: string | number | null | undefined) => (w ? dateDay(w).slice(0, 5) : '—');

const SECTION: Record<Exclude<StageId, 'calc'>, RequestSection> = { files: 'journal', prices: 'stages', ai: 'stages' };

function Pill({ stage, icon, text, detail, className }: { stage: Exclude<StageId, 'calc'>; icon: ReactNode; text: ReactNode; detail: string; className?: string }): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-pill={stage}
          aria-label={`Этап «${STAGE_LABEL[stage]}»: ${detail}`}
          onClick={() => openSheet({ kind: 'request', section: SECTION[stage] })}
          className={cn('shrink-0 gap-1.5 px-2 font-normal tabular-nums [&_svg]:size-3.5', className)}
        >
          {icon}
          <span className="whitespace-nowrap">{text}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-80 whitespace-pre-line">{detail}</TooltipContent>
    </Tooltip>
  );
}

const spin = <Spinner aria-hidden role="presentation" aria-label={undefined} />;

/** Ошибки чтения файлов в последнем разборе (записи журнала уровня error после начала этапа «Файлы») */
const parseErrors = (s: AppState): number => {
  const st = s.pipeline.stages.files;
  if (st.startedAt == null || st.status === 'running') return 0;
  const from = st.startedAt;
  return (s.order.journal ?? []).filter((e) => e.level === 'error' && Date.parse(e.at) >= from).length;
};

function FilesPill(): ReactElement {
  const stage = useStore((s) => s.pipeline.stages.files);
  const parse = useStore((s) => s.pipeline.parse);
  const n = useStore((s) => s.order.positions.length);
  const errors = useStore(parseErrors);
  if (stage.status === 'running') {
    const text = parse && parse.total ? `Чтение ${parse.done}/${parse.total}` : 'Чтение…';
    return <Pill stage="files" icon={spin} text={text} detail={stage.detail || 'Читаю файлы…'} />;
  }
  const detail = stage.detail || `${n} ${plural(n, 'позиция', 'позиции', 'позиций')}`;
  if (errors) {
    return (
      <Pill
        stage="files"
        icon={<TriangleAlert aria-hidden className="text-warn" />}
        text={`Файлы ${n} · ${errors} ${plural(errors, 'ошибка', 'ошибки', 'ошибок')}`}
        detail={detail}
      />
    );
  }
  return <Pill stage="files" icon={<CircleCheck aria-hidden className="text-ok" />} text={`Файлы ${n}`} detail={detail} />;
}

function PricesPill(): ReactElement {
  const stage = useStore((s) => s.pipeline.stages.prices);
  const loaded = useStore((s) => s.prices.loaded);
  const live = useStore((s) => s.prices.live);
  const busy = useStore((s) => s.prices.busy);
  const book = useStore((s) => s.prices.book);
  const issue = useStore((s) => s.prices.issue);
  const maxAge = useStore((s) => s.settings.priceMaxAgeHours ?? 24);
  const { res } = useDerived();
  if (!loaded || stage.status === 'running' || busy) {
    return <Pill stage="prices" icon={spin} text="Цены…" detail={(stage.status === 'running' && stage.detail) || busy || 'Загрузка цен…'} />;
  }
  if (!live) {
    return (
      <Pill
        stage="prices"
        icon={<CircleMinus aria-hidden className="text-muted-foreground" />}
        text={`Цены: снимок ${ddmm(book.updatedAt)}`}
        detail={`Статическая версия: цены из снимка от ${dateDay(book.updatedAt)}, обновление недоступно`}
      />
    );
  }
  // самая старая дата получения среди пар заказа; оценки и устаревшие цены — повод проверить
  let oldest: string | null = null;
  const estimate: string[] = [];
  const old: string[] = [];
  for (const g of res.groups) {
    const label = `${g.material.short} ${thick(g.t)}`;
    if (g.chosen.offer.source === 'estimate') estimate.push(label);
    const at = pairFetchedAt(book, g.material.id, g.t);
    if (at && (!oldest || at < oldest)) oldest = at;
    if (g.chosen.offer.source === 'mc' && pairAge(book, g.material.id, g.t) > maxAge) old.push(label);
  }
  const date = ddmm(oldest ?? book.updatedAt);
  const reasons: string[] = [];
  if (issue) reasons.push(issue.reason);
  if (estimate.length) reasons.push(`Нет нужной толщины на mc.ru, цена оценена: ${estimate.join(', ')}`);
  if (old.length) reasons.push(`Цены старше ${maxAge} ч: ${old.join(', ')}`);
  if (reasons.length) {
    return <Pill stage="prices" icon={<TriangleAlert aria-hidden className="text-warn" />} text={`Цены ${date}`} detail={reasons.join('\n')} />;
  }
  const detail = stage.status === 'done' && stage.detail ? stage.detail : `Цены mc.ru от ${dateDay(oldest ?? book.updatedAt)}`;
  return <Pill stage="prices" icon={<CircleCheck aria-hidden className="text-ok" />} text={`Цены ${date}`} detail={detail} />;
}

function AiPill(): ReactElement {
  const stage = useStore((s) => s.pipeline.stages.ai);
  const run = useStore((s) => s.ai.run);
  const pending = useStore((s) => s.ai.pending);
  const outcome = useStore((s) => s.ai.outcome);
  const server = useStore((s) => s.ai.server);
  const analysis = useStore((s) => s.order.ai?.analysis);
  const { outdated } = useDerived();
  const running = !!run || stage.status === 'running';
  const now = useNow(running);
  if (running) {
    const text = run ? `ИИ ${elapsed(now - run.startedAt)}` : 'ИИ…';
    return <Pill stage="ai" icon={spin} text={text} detail={run ? jobDetail(run.job, run.startedAt, server?.model ?? null, now) : 'Анализ ИИ…'} />;
  }
  if (pending) {
    return (
      <Pill
        stage="ai"
        icon={
          <span className="relative inline-flex">
            <Sparkles aria-hidden className="text-ai" />
            <span aria-hidden className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-ai ring-2 ring-background" />
          </span>
        }
        text="ИИ готов"
        detail={`${readyText(pending.analysis)} — результат ещё не применён`}
      />
    );
  }
  if (outcome.kind === 'error') {
    return <Pill stage="ai" icon={<CircleX aria-hidden className="text-danger" />} text="ИИ: ошибка" detail={outcome.message} />;
  }
  if (analysis && outdated) {
    return (
      <Pill
        stage="ai"
        icon={<History aria-hidden className="text-warn" />}
        text="ИИ устарел"
        detail="Заказ изменился после анализа — изменения ИИ остаются в расчёте"
      />
    );
  }
  if (analysis) {
    const sec = Math.round(analysis.durationMs / 1000);
    return <Pill stage="ai" icon={<Sparkles aria-hidden className="text-ai" />} text="ИИ" detail={`${shortModel(analysis.model)} · ${sec} с`} />;
  }
  const why =
    outcome.kind === 'skipped'
      ? outcome.reason
      : outcome.kind === 'cancelled'
        ? 'Анализ отменён'
        : server && !server.configured
          ? 'ИИ не подключён на сервере'
          : 'Анализ ИИ не выполнялся';
  return <Pill stage="ai" icon={<CircleMinus aria-hidden className="text-muted-foreground" />} text="Без ИИ" detail={why} />;
}

/** Три пилюли этапов; на пустом экране не показываются */
export function StagePills({ className }: { className?: string }): ReactElement | null {
  const empty = useStore((s) => !s.pipeline.processing && !s.order.positions.length);
  if (empty) return null;
  return (
    <nav aria-label="Этапы расчёта" className={cn('flex items-center gap-0.5', className)}>
      <FilesPill />
      <PricesPill />
      <AiPill />
    </nav>
  );
}
