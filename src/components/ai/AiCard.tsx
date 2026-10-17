// Карточка «Анализ ИИ» (id="ai-card" — контракт, к ней прокручивает P1): итог и уверенность, «Требует внимания»
// с разбором по очереди, вопросы клиенту, риски, рекомендации, «Что видел ИИ». Свёрнута — одна строка счётчиков.
// Авто (ui.aiCardOpen = null): раскрыта, если есть открытые проблемы, идёт анализ или ждёт поздний результат.
// Телефон: одна строка, полная карточка — в нижней панели.
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { toast } from 'sonner';
import { appliedCount, pendingOffers } from '@/ai/apply.ts';
import type { AiAnalysis } from '@/core/ai.ts';
import { dateDay, dateShort, elapsed, hhmm, n0, n2, NBSP, plural, signedRub } from '@/format.ts';
import { cn } from '@/lib/utils.ts';
import { useMediaQuery } from '@/hooks/useMediaQuery.ts';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card } from '@/components/ui/card.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible.tsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx';
import { ScrollArea } from '@/components/ui/scroll-area.tsx';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleCheck,
  CircleHelp,
  Copy,
  Ellipsis,
  History,
  OctagonAlert,
  RefreshCw,
  Sparkles,
  TriangleAlert,
} from '@/components/common/icons.ts';
import { setAiCardOpen, setFilter, setQuoteQuestions, setTab } from '@/store/actions.ts';
import { acceptAllPending, revertAllAi, startTriage } from '@/store/aiActions.ts';
import { useDerived } from '@/store/derived.tsx';
import { cancelAnalysis, runAnalysis } from '@/store/pipelineActions.ts';
import { useStore } from '@/store/store.ts';
import type { AiRun } from '@/store/types.ts';
import { AiContextView } from './AiContextView.tsx';
import { AiText } from './AiText.tsx';
import { AttentionList } from './AttentionList.tsx';
import { PendingAiBanner } from './PendingAiBanner.tsx';
import { useAcceptAllDelta } from './useSuggestionDelta.ts';

// ---------- подписи ----------

const CONFIDENCE: Record<AiAnalysis['confidence'], { word: string; icon: ReactNode }> = {
  high: { word: 'высокая', icon: <CircleCheck aria-hidden className="text-ok" /> },
  medium: { word: 'средняя', icon: <TriangleAlert aria-hidden className="text-warn" /> },
  low: { word: 'низкая', icon: <OctagonAlert aria-hidden className="text-danger" /> },
};

/** «anthropic/claude-haiku-5.5» → «claude-haiku-5.5» */
const shortModel = (m: string) => m.replace(/^.*\//, '');
/** Та же модель: без поставщика и даты версии («gpt-4o-mini-2024-07-18» = «openai/gpt-4o-mini»), как bareModel на сервере */
const sameModel = (a: string, b: string) => {
  const k = (m: string) =>
    shortModel(m.trim().toLowerCase()).replace(/[-@](?:\d{4}-\d{2}-\d{2}|\d{8}|latest)$/, '');
  return k(a) === k(b);
};

const problems = (n: number) => `${n}${NBSP}${plural(n, 'проблема', 'проблемы', 'проблем')}`;
const questionsWord = (n: number) => `${n}${NBSP}${plural(n, 'вопрос', 'вопроса', 'вопросов')}`;

function jobText(run: AiRun, now: number, model: string | null): string {
  const j = run.job;
  if (!j) return 'Готовлю данные для ИИ…';
  if (j.status === 'waiting') return `Отправляю чертежи: ${j.imagesReceived} из ${j.imagesExpected}`;
  if (j.status === 'queued') return `В очереди, место ${j.position}`;
  if (j.status === 'running') return `${shortModel(j.model ?? model ?? 'ИИ')} · ${elapsed(now - run.startedAt)} · обычно 20–60 с`;
  return 'Готовлю данные для ИИ…';
}

/** Секундомер, пока идёт анализ */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // запасной путь: выделение во временном поле
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

// ---------- модель карточки ----------

function useCardModel() {
  const d = useDerived();
  const order = useStore((s) => s.order);
  const ai = useStore((s) => s.ai);
  const live = useStore((s) => s.prices.live);
  const loaded = useStore((s) => s.prices.loaded);
  const analysis = order.ai?.analysis ?? null;
  const applied = appliedCount(order.ai, order.positions);
  const pending = pendingOffers(order.ai, order.positions).length;
  const enabled = order.positions.filter((p) => !p.disabled);
  const scope = order.aiScope?.length ? new Set(order.aiScope) : null;
  const checked = scope ? enabled.filter((p) => scope.has(p.id)).length : enabled.length;
  const fallback =
    !!analysis && (analysis.fallback === true || (!!ai.server?.model && analysis.model !== ai.server.model && !sameModel(analysis.model, ai.server.model)));
  return { d, order, ai, live, loaded, analysis, applied, pending, enabled, checked, fallback };
}

type Model = ReturnType<typeof useCardModel>;

// ---------- шапка ----------

/** Анализ сделан сегодня: время без даты */
const sameDay = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();

function Meta({ a }: { a: AiAnalysis }): ReactElement {
  const cost = a.usage?.costRub;
  const usage = a.usage ? ` · токенов: ${n0(a.usage.promptTokens)} + ${n0(a.usage.completionTokens)}` : '';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="focus-ring cursor-default rounded-sm text-xs text-muted-foreground tabular-nums">
          {shortModel(a.model)} · {Math.max(1, Math.round(a.durationMs / 1000))}
          {NBSP}с · {sameDay(a.createdAt) ? hhmm(a.createdAt) : dateShort(a.createdAt)}
          {cost != null ? ` · ${n2(cost)}${NBSP}₽` : ''}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        Модель {a.model}, анализ от {dateDay(a.createdAt)} {hhmm(a.createdAt)}
        {usage}
      </TooltipContent>
    </Tooltip>
  );
}

/** titled = false — в нижней панели телефона: заголовок «Анализ ИИ» уже в шапке панели */
function Header({ m, open, onToggle, titled = true }: { m: Model; open: boolean; onToggle?: boolean; titled?: boolean }): ReactElement {
  const { analysis, d, ai } = m;
  const configured = !!ai.server?.configured;
  const conf = analysis ? CONFIDENCE[analysis.confidence] : null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      {titled && (
        <>
          <Sparkles aria-hidden className="size-4 text-ai" />
          <h2 className="text-base leading-snug font-semibold">Анализ ИИ</h2>
        </>
      )}
      {conf && (
        <Badge variant="outline" className="gap-1 font-normal">
          {conf.icon}
          Уверенность: {conf.word}
        </Badge>
      )}
      {analysis && <Meta a={analysis} />}
      {m.fallback && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" tabIndex={0} className="focus-ring cursor-default border-warn/50 font-normal text-warn">
              резервная модель
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-72">Основная модель была недоступна — ответила резервная; анализ может быть менее точным</TooltipContent>
        </Tooltip>
      )}
      {analysis && d.outdated && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" tabIndex={0} className="focus-ring cursor-default border-warn/50 font-normal text-warn">
              <History aria-hidden />
              Устарел
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-72">
            Заказ изменился после анализа — изменения ИИ остаются в расчёте.{configured ? '' : ' ИИ сейчас недоступен, обновить анализ нельзя.'}
          </TooltipContent>
        </Tooltip>
      )}
      {ai.run && analysis && <span className="text-xs text-muted-foreground">обновляется</span>}
      <div className="ml-auto flex items-center gap-1">
        {analysis && d.outdated && !ai.run && configured && (
          <Button variant="outline" size="sm" onClick={() => void runAnalysis()}>
            <RefreshCw aria-hidden />
            Обновить анализ ИИ
          </Button>
        )}
        {!analysis && !open && configured && !ai.run && m.enabled.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => void runAnalysis()}>
            <Sparkles aria-hidden className="text-ai" />
            Запустить анализ ИИ
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Действия с анализом ИИ">
              <Ellipsis aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuItem disabled={!configured || !!ai.run} onSelect={() => void runAnalysis()}>
              <RefreshCw aria-hidden />
              <span className="flex flex-col">
                Запустить анализ заново
                {!configured && <span className="text-xs text-muted-foreground">ИИ не подключён на сервере</span>}
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {onToggle && (
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={open ? 'Свернуть анализ ИИ' : 'Развернуть анализ ИИ'}>
              {open ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
            </Button>
          </CollapsibleTrigger>
        )}
      </div>
    </div>
  );
}

/** Состояние без анализа одной фразой (для свёрнутой строки и телефона) */
function noAnalysisWord(m: Model): string {
  if (m.ai.run) return 'идёт анализ…';
  if (m.loaded && !m.live) return 'статическая версия, без ИИ';
  if (m.ai.server && !m.ai.server.configured) return 'не подключён на сервере';
  if (m.ai.outcome.kind === 'error') return 'анализ не выполнен';
  return 'анализ не выполнялся';
}

/** Свёрнутая строка: «⬢ 1 проблема · ▲ 5 проверить · ? 2 вопроса · Применено 4 · ждут решения 3 · +1 240 ₽» */
function CollapsedLine({ m }: { m: Model }): ReactElement {
  const { counts } = m.d.attention;
  const q = m.analysis?.questions.length ?? 0;
  const parts: ReactNode[] = [];
  if (!m.analysis) parts.push(<span key="s">{noAnalysisWord(m)}</span>);
  if (counts.problem) parts.push(<Count key="p" icon={<OctagonAlert aria-hidden className="text-danger" />} text={problems(counts.problem)} />);
  if (counts.check) parts.push(<Count key="c" icon={<TriangleAlert aria-hidden className="text-warn" />} text={`${counts.check}${NBSP}проверить`} />);
  if (q) parts.push(<Count key="q" icon={<CircleHelp aria-hidden className="text-muted-foreground" />} text={questionsWord(q)} />);
  if (m.applied) parts.push(<span key="a">Применено {m.applied}</span>);
  if (m.pending) parts.push(<span key="m">ждут решения {m.pending}</span>);
  if (m.analysis && Math.abs(m.d.aiImpact) >= 0.005) parts.push(<span key="d">ИИ: {signedRub(m.d.aiImpact)}</span>);
  if (m.analysis && !counts.problem && !counts.check && !m.pending)
    parts.push(
      <span key="ok" className="text-ok">
        Всё проверено — можно отправлять клиенту
      </span>,
    );
  return (
    <CollapsibleTrigger asChild>
      <button
        type="button"
        className="focus-ring flex w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-md text-left text-sm text-muted-foreground tabular-nums hover:text-foreground"
      >
        {parts.map((p, i) => (
          <span key={i} className="inline-flex items-center gap-2">
            {i > 0 && <span aria-hidden>·</span>}
            {p}
          </span>
        ))}
        <ChevronRight aria-hidden className="size-3.5" />
      </button>
    </CollapsibleTrigger>
  );
}

function Count({ icon, text }: { icon: ReactNode; text: string }): ReactElement {
  return (
    <span className="inline-flex items-center gap-1 [&>svg]:size-3.5">
      {icon}
      {text}
    </span>
  );
}

// ---------- тело ----------

function Running({ m }: { m: Model }): ReactElement | null {
  const run = m.ai.run;
  const now = useNow(!!run);
  if (!run) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 text-sm">
      <Spinner className="text-ai" />
      <span>{run.job || m.analysis ? jobText(run, now, m.ai.server?.model ?? null) : 'Идёт анализ ИИ…'}</span>
      <span className="text-xs text-muted-foreground tabular-nums">{elapsed(now - run.startedAt)}</span>
      <Button variant="ghost" size="sm" onClick={cancelAnalysis}>
        Отменить анализ
      </Button>
    </div>
  );
}

/** Нет анализа: ровно одно из состояний (статическая версия, не подключён, ошибка, не запускался, нет деталей) */
function NoAnalysis({ m }: { m: Model }): ReactElement | null {
  const { ai } = m;
  const book = useStore((s) => s.prices.book);
  if (m.analysis || ai.run || ai.pending) return null;
  if (!m.enabled.some((p) => p.qty > 0)) return <p className="text-sm text-muted-foreground">В заказе нет деталей для анализа.</p>;
  if (m.loaded && !m.live) {
    return (
      <Alert>
        <AlertTitle>Статическая версия без сервера</AlertTitle>
        <AlertDescription>ИИ и обновление цен недоступны; цены — из снимка от {dateDay(book.updatedAt)}.</AlertDescription>
      </Alert>
    );
  }
  if (ai.server && !ai.server.configured) {
    return (
      <Alert>
        <AlertTitle>ИИ не подключён на сервере</AlertTitle>
        <AlertDescription>Расчёт сделан без проверки ИИ. Сверьте количество с заявкой вручную.</AlertDescription>
      </Alert>
    );
  }
  if (ai.outcome.kind === 'error') {
    return (
      <Alert variant="destructive">
        <OctagonAlert aria-hidden />
        <AlertTitle>Анализ ИИ не выполнен</AlertTitle>
        <AlertDescription>
          <p>{ai.outcome.message} Цена посчитана по чертежам, без проверки.</p>
          <Button variant="outline" size="sm" className="mt-2 text-foreground" onClick={() => void runAnalysis()}>
            <RefreshCw aria-hidden />
            Повторить
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-sm text-muted-foreground">Анализ ИИ не выполнялся</span>
      <Button variant="outline" size="sm" disabled={!ai.server?.configured} onClick={() => void runAnalysis()}>
        <Sparkles aria-hidden className="text-ai" />
        Запустить анализ ИИ
      </Button>
    </div>
  );
}

function MetaRow({ m, onQuestions }: { m: Model; onQuestions: () => void }): ReactElement | null {
  const { counts } = m.d.attention;
  const q = m.analysis?.questions.length ?? 0;
  const delta = useAcceptAllDelta(m.pending > 0);
  if (!m.analysis) return null;
  const toAttention = () => {
    setFilter('attention');
    setTab('positions');
  };
  const toApplied = () => {
    setFilter('ai');
    setTab('positions');
  };
  const chip = 'focus-ring inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs tabular-nums hover:bg-muted [&>svg]:size-3.5';
  const impact = m.d.aiImpact;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      {(counts.problem > 0 || counts.check > 0 || q > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {counts.problem > 0 && (
            <button type="button" className={chip} onClick={toAttention} title="Показать позиции, которые требуют внимания">
              <OctagonAlert aria-hidden className="text-danger" />
              {problems(counts.problem)}
            </button>
          )}
          {counts.check > 0 && (
            <button type="button" className={chip} onClick={toAttention} title="Показать позиции, которые требуют внимания">
              <TriangleAlert aria-hidden className="text-warn" />
              {counts.check}
              {NBSP}проверить
            </button>
          )}
          {q > 0 && (
            <button type="button" className={chip} onClick={onQuestions} title="К вопросам клиенту">
              <CircleHelp aria-hidden className="text-muted-foreground" />
              {questionsWord(q)}
            </button>
          )}
        </div>
      )}
      {(m.applied > 0 || m.pending > 0) && (
        <span className="inline-flex items-center gap-1 text-muted-foreground tabular-nums">
          {m.applied > 0 ? (
            <Button variant="link" size="xs" className="h-auto px-0 text-sm" title="Показать позиции, изменённые ИИ" onClick={toApplied}>
              Применено {m.applied}
            </Button>
          ) : (
            <span>Применено 0</span>
          )}
          <span aria-hidden>·</span>
          <span>ждут решения {m.pending}</span>
        </span>
      )}
      {(m.applied > 0 || Math.abs(impact) >= 0.005) && (
        <span className="inline-flex flex-wrap items-center gap-x-2 tabular-nums">
          <span>
            ИИ изменил цену клиенту: <span className="font-medium">{signedRub(impact)}</span>
          </span>
          {m.applied > 0 && (
            <Button variant="link" size="xs" className="h-auto px-0" onClick={revertAllAi}>
              Отменить изменения ИИ
            </Button>
          )}
        </span>
      )}
      {m.pending > 0 && (
        <Button variant="outline" size="sm" className="text-ai tabular-nums hover:text-ai" onClick={acceptAllPending}>
          Принять все предложения ({m.pending}){delta != null && Math.abs(delta) >= 0.005 ? ` · ${signedRub(delta)}` : ''}
        </Button>
      )}
    </div>
  );
}

function ColumnHead({ children, aside }: { children: ReactNode; aside?: ReactNode }): ReactElement {
  return (
    <div className="mb-1.5 flex items-baseline gap-2">
      <h3 className="text-sm font-semibold">{children}</h3>
      {aside && <span className="text-xs text-muted-foreground tabular-nums">{aside}</span>}
    </div>
  );
}

/** Список в прокрутке (до 18rem) с затуханием снизу, пока есть что прокручивать */
function FadeScroll(): ReactElement {
  const [more, setMore] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const vp = root.current?.querySelector<HTMLElement>('[data-slot=scroll-area-viewport]');
    if (!vp) return;
    const check = () => setMore(vp.scrollHeight - vp.scrollTop - vp.clientHeight > 4);
    check();
    vp.addEventListener('scroll', check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(vp);
    if (vp.firstElementChild) ro.observe(vp.firstElementChild);
    return () => {
      vp.removeEventListener('scroll', check);
      ro.disconnect();
    };
  }, []);
  return (
    <div className="relative">
      <ScrollArea ref={root} className="-mx-2 px-2 *:data-[slot=scroll-area-viewport]:max-h-72">
        <AttentionList />
      </ScrollArea>
      {more && <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-linear-to-t from-card to-transparent" />}
    </div>
  );
}

function AttentionColumn({ m, flat }: { m: Model; flat?: boolean }): ReactElement {
  const { attention } = m.d;
  const { counts } = attention;
  const open = attention.open.length;
  return (
    <div className="min-w-0">
      <ColumnHead aside={counts.total > 0 && counts.resolved > 0 ? `решено ${counts.resolved} из ${counts.total}` : undefined}>
        Требует внимания ({open})
      </ColumnHead>
      {attention.sections.length > 0 || attention.offerGroups.length > 0 ? flat ? <AttentionList /> : <FadeScroll /> : null}
      {attention.done && m.pending > 0 ? (
        // замечания закрыты, а предложения ИИ ещё ждут решения — «Принять все предложения» выше или чипы в таблице
        <p className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground tabular-nums">
          <TriangleAlert aria-hidden className="size-4 shrink-0 text-warn" />
          {m.pending}
          {NBSP}
          {plural(m.pending, 'предложение', 'предложения', 'предложений')} ИИ {plural(m.pending, 'ждёт', 'ждут', 'ждут')} решения
        </p>
      ) : attention.done ? (
        <p className="mt-2 flex items-center gap-1.5 text-sm text-ok">
          <CircleCheck aria-hidden className="size-4" />
          Всё проверено — можно отправлять клиенту
        </p>
      ) : (
        <Button className="mt-3" onClick={startTriage}>
          Разобрать по очереди ({open})
        </Button>
      )}
    </div>
  );
}

function QuestionsColumn({ a, id }: { a: AiAnalysis; id: string }): ReactElement {
  const on = useStore((s) => s.ui.quoteQuestions);
  const n = a.questions.length;
  const copy = async () => {
    const ok = await copyText(a.questions.map((q, i) => `${i + 1}. ${q}`).join('\n'));
    if (ok) toast.success('Вопросы скопированы');
    else toast.error('Не удалось скопировать');
  };
  return (
    <div id={id} tabIndex={-1} className="min-w-0 outline-none">
      <ColumnHead>Вопросы клиенту ({n})</ColumnHead>
      {n ? (
        <>
          <ol className="list-decimal space-y-1 pl-5 text-sm marker:text-muted-foreground">
            {a.questions.map((q, i) => (
              <li key={i}>
                <AiText text={q} />
              </li>
            ))}
          </ol>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Button variant="outline" size="sm" onClick={() => void copy()}>
              <Copy aria-hidden />
              Скопировать вопросы
            </Button>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={on} onCheckedChange={(v) => setQuoteQuestions(v === true)} />в текст для клиента
            </label>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Вопросов нет.</p>
      )}
    </div>
  );
}

function ListBlock({ title, items }: { title: string; items: string[] }): ReactElement | null {
  const [open, setOpen] = useState(true);
  if (!items.length) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button type="button" className="focus-ring mb-1 inline-flex items-center gap-1 rounded-sm text-sm font-semibold">
          {title} ({items.length})
          {open ? (
            <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight aria-hidden className="size-3.5 text-muted-foreground" />
          )}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="list-disc space-y-1 pl-5 text-sm marker:text-muted-foreground">
          {items.map((x, i) => (
            <li key={i}>
              <AiText text={x} />
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Body({ m, flat }: { m: Model; flat?: boolean }): ReactElement {
  const { analysis, ai } = m;
  const [ctxOpen, setCtxOpen] = useState(false);
  const qid = 'ai-questions';
  const toQuestions = () => {
    const el = document.getElementById(qid);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    el?.focus({ preventScroll: true });
  };
  const toUnchecked = () => {
    setFilter('unchecked');
    setTab('positions');
  };
  const missing = m.enabled.length - m.checked;
  return (
    <div className="space-y-4">
      <PendingAiBanner />
      <Running m={m} />
      <NoAnalysis m={m} />
      <div className={cn('space-y-4', ai.run && analysis && 'opacity-60 transition-opacity')}>
        {analysis && <AiText as="p" text={analysis.summary} evidence className="max-w-[110ch] text-sm leading-relaxed" />}
        <MetaRow m={m} onQuestions={toQuestions} />
        <div className={cn('grid gap-6', analysis ? 'lg:grid-cols-[1.4fr_1fr_1fr]' : 'max-w-[120ch]')}>
          <AttentionColumn m={m} flat={flat} />
          {analysis && <QuestionsColumn a={analysis} id={qid} />}
          {analysis && (analysis.risks.length > 0 || analysis.recommendations.length > 0) && (
            <div className="min-w-0 space-y-4">
              <ListBlock title="Риски" items={analysis.risks} />
              <ListBlock title="Рекомендации" items={analysis.recommendations} />
            </div>
          )}
        </div>
        {analysis && (
          <div className="flex flex-wrap items-start gap-x-6 gap-y-2 border-t pt-3">
            <Collapsible open={ctxOpen} onOpenChange={setCtxOpen} className="min-w-0 flex-1 basis-80">
              <CollapsibleTrigger asChild>
                <button type="button" className="focus-ring inline-flex items-center gap-1 rounded-sm text-sm text-muted-foreground hover:text-foreground">
                  {ctxOpen ? <ChevronDown aria-hidden className="size-3.5" /> : <ChevronRight aria-hidden className="size-3.5" />}
                  Что видел ИИ
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2">
                <AiContextView />
              </CollapsibleContent>
            </Collapsible>
            {missing > 0 && (
              <span className="text-sm text-muted-foreground tabular-nums">
                ИИ проверил {m.checked} из {m.enabled.length} {plural(m.enabled.length, 'позиции', 'позиций', 'позиций')} ·{' '}
                <Button variant="link" size="xs" className="h-auto px-0" onClick={toUnchecked}>
                  Показать непроверенные
                </Button>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- карточка ----------

function DesktopCard(): ReactElement {
  const m = useCardModel();
  const pref = useStore((s) => s.ui.aiCardOpen);
  const auto = m.d.attention.counts.problem > 0 || !!m.ai.run || !!m.ai.pending;
  // раскрылась сама — не схлопывается, когда последняя проблема решена (таблица не прыгает под рукой)
  const [held, setHeld] = useState(false);
  if (auto && !held) setHeld(true);
  const open = pref ?? (auto || held);
  return (
    <Card id="ai-card" role="region" aria-label="Анализ ИИ" className="scroll-mt-28 gap-0 py-0">
      <Collapsible open={open} onOpenChange={setAiCardOpen}>
        <div className="space-y-2 px-4 py-3">
          <Header m={m} open={open} onToggle />
          {!open && <CollapsedLine m={m} />}
        </div>
        <CollapsibleContent className="border-t px-4 pt-3 pb-4">
          <Body m={m} />
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function PhoneCard(): ReactElement {
  const m = useCardModel();
  const [open, setOpen] = useState(false);
  const sheet = useStore((s) => s.ui.sheet);
  const { counts } = m.d.attention;
  // карточка позиции открылась (переход из замечания) — нижняя панель ИИ уступает место
  useEffect(() => {
    if (sheet) setOpen(false);
  }, [sheet]);
  const parts = [
    counts.problem ? problems(counts.problem) : '',
    counts.check ? `${counts.check}${NBSP}проверить` : '',
    m.pending ? `ждут решения ${m.pending}` : '',
  ].filter(Boolean);
  return (
    <div id="ai-card" className="scroll-mt-28">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="focus-ring flex h-11 w-full items-center gap-2 rounded-xl border bg-card px-3 text-left text-sm"
        aria-haspopup="dialog"
      >
        <Sparkles aria-hidden className="size-4 shrink-0 text-ai" />
        <span className="min-w-0 flex-1 truncate">
          ИИ: {m.ai.run ? 'идёт анализ…' : parts.length ? parts.join(' · ') : m.analysis ? 'замечаний нет' : noAnalysisWord(m)}
        </span>
        <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="gap-0 p-0 data-[side=bottom]:h-[92dvh] data-[side=bottom]:rounded-t-xl"
          // фокус — на саму панель: первая подсказка (модель, время) не всплывает при открытии
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus({ preventScroll: true });
          }}
        >
          <SheetHeader className="border-b px-4 py-3">
            <SheetTitle className="flex items-center gap-2">
              <Sparkles aria-hidden className="size-4 text-ai" />
              Анализ ИИ
            </SheetTitle>
            <SheetDescription className="sr-only">Итог анализа, замечания и вопросы клиенту</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <div className="mb-3">
              <Header m={m} open titled={false} />
            </div>
            <Body m={m} flat />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

export function AiCard(): ReactElement {
  const phone = useMediaQuery('(max-width: 767px)');
  return phone ? <PhoneCard /> : <DesktopCard />;
}
