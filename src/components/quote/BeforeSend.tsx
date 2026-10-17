// «Перед отправкой»: что ещё не проверено (ошибки, пункты для проверки, цены металла, вопросы клиенту)
// и внутренняя строка «Только для вас» — в КП она не попадает.
import type { ReactElement, ReactNode } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { ChevronRight, CircleCheck, Info, Lock, OctagonAlert, TriangleAlert } from '@/components/common/icons.ts';
import { cn } from '@/lib/utils.ts';
import { dateDay, pct1, plural, rub0 } from '@/format.ts';
import { pendingOffers } from '@/ai/apply.ts';
import type { AttentionItem } from '@/attention.ts';
import type { AiSuggestionKind } from '@/core/ai.ts';
import { materialText } from '@/quote.ts';
import { pairFetchedAt } from '@/prices.ts';
import { openPosition, openSheet, setQuoteQuestions, setTab } from '@/store/actions.ts';
import { acknowledge, startTriage } from '@/store/aiActions.ts';
import { useDerived } from '@/store/derived.tsx';
import { runAnalysis } from '@/store/pipelineActions.ts';
import { useStore } from '@/store/store.ts';

/** «Заявка и документы» на поле заявки клиента */
const toRequest = () => openSheet({ kind: 'request', section: 'request' });

/** Открыть замечание: позицию (с нужным полем) или замечание по заказу */
function openItem(item: AttentionItem): void {
  const open = item.actions.find((a) => a.kind === 'open');
  if (open?.kind === 'open') openPosition(open.positionId, { focus: open.focus });
  else if (item.positionId) openPosition(item.positionId);
  else openSheet({ kind: 'item', itemId: item.id });
}

function Row({ icon, children, className }: { icon: ReactNode; children: ReactNode; className?: string }): ReactElement {
  return (
    <li className={cn('flex items-start gap-2', className)}>
      <span className="mt-0.5 shrink-0 [&_svg]:size-4">{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

/** Строка-ссылка: текст и → (весь ряд нажимается) */
function LinkRow({ onClick, children }: { onClick: () => void; children: ReactNode }): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group -mx-1 flex w-[calc(100%+0.5rem)] items-start gap-1 rounded-sm px-1 text-left hover:bg-muted focus-ring"
    >
      <span className="min-w-0 flex-1 group-hover:underline">{children}</span>
      <ChevronRight aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

export function BeforeSend(): ReactElement {
  const d = useDerived();
  const ai = useStore((s) => s.order.ai);
  const positions = useStore((s) => s.order.positions);
  const acks = useStore((s) => s.order.checks);
  const hasRequest = useStore((s) => !!s.order.request?.trim());
  const hasDocs = useStore((s) => !!s.order.documents?.length || !!s.order.requestLines?.length);
  const ctx = useStore((s) => s.ai.lastContext);
  const canRun = useStore((s) => !!s.ai.server?.configured && !s.ai.run);
  const book = useStore((s) => s.prices.book);
  const withQuestions = useStore((s) => s.ui.quoteQuestions);
  const q = d.quote;
  const open = d.attention.open;
  const problems = open.filter((i) => i.severity === 'problem');
  const checks = open.filter((i) => i.severity === 'check');
  const prices = checks.filter((i) => i.section === 'prices');

  // замечания о количестве: заявка, «не найдено в файле» для кол-ва, предложения ИИ по количеству
  const kindOf = new Map<string, AiSuggestionKind>();
  for (const r of ai?.analysis.positions ?? []) for (const s of r.suggestions) kindOf.set(s.id, s.kind);
  const isQty = (i: AttentionItem) =>
    i.section === 'request' ||
    (i.kind === 'guessed' && i.id.includes(':qty:')) ||
    i.actions.some((a) => (a.kind === 'accept' || a.kind === 'reject') && a.suggestionIds.some((id) => kindOf.get(id) === 'qty'));
  const qtyOpen = open.some(isQty);
  const qtyAcked = !ai && d.attention.items.some((i) => i.kind === 'qtyUnverified' && i.closed);
  const pending = pendingOffers(ai, positions).length;
  const questions = (ai?.analysis.questions ?? []).filter((x) => x.trim()).length;

  // С чем ИИ мог сверить количество: заявка клиента или документы заказа (.txt, листы PDF без чертежа, строки заявок).
  // Анализ устарел — заявку могли вставить уже после него: смотрим, что видел ИИ (контекст анализа — только в памяти,
  // после перезагрузки считаем, что видел текущие)
  const seen = ai && d.outdated && ctx;
  const seenRequest = seen ? !!ctx.order.request.trim() : hasRequest;
  const seenDocs = seen ? ctx.documents.length > 0 || ctx.unmatchedRequestLines.length > 0 : hasDocs;
  // «Количество верное» без заявки — до новых позиций
  const noSourceId = `qty-nosource:${positions.filter((p) => !p.disabled).length}`;
  const qtyRow = (ok: boolean, children: ReactNode) => (
    <Row icon={ok ? <CircleCheck className="text-ok" /> : <TriangleAlert className="text-warn" />}>{children}</Row>
  );
  let qtyOk = false;
  let qty: ReactElement;
  if (qtyOpen || (!ai && !qtyAcked)) {
    qty = qtyRow(false, <LinkRow onClick={toRequest}>Количество не сверено с заявкой</LinkRow>);
  } else if (!ai) {
    qtyOk = true;
    qty = qtyRow(true, 'Количество сверено с заявкой (вручную)');
  } else if (hasRequest ? seenRequest : hasDocs && seenDocs) {
    qtyOk = true;
    qty = qtyRow(true, hasRequest ? 'Количество сверено с заявкой (ИИ)' : 'Количество сверено с документами заказа (ИИ)');
  } else if (hasRequest || hasDocs) {
    // заявку (документы) добавили после анализа — ИИ количество с ними не сверял
    qty = qtyRow(
      false,
      <div className="flex flex-wrap items-center gap-x-2">
        <span>{hasRequest ? 'Заявка добавлена после анализа ИИ — количество с ней не сверено' : 'Документы добавлены после анализа ИИ — количество с ними не сверено'}</span>
        {canRun && (
          <Button variant="link" size="xs" className="h-auto px-0" onClick={() => void runAnalysis()}>
            Обновить анализ ИИ
          </Button>
        )}
      </div>,
    );
  } else if (acks?.[noSourceId]) {
    qtyOk = true;
    qty = qtyRow(true, 'Количество проверено вручную — заявки нет');
  } else {
    qty = qtyRow(
      false,
      <>
        <LinkRow onClick={toRequest}>Заявки нет — количество взято из файлов · Добавить заявку</LinkRow>
        <Button variant="link" size="xs" className="h-auto px-0" title="Количество проверено — заявки нет" onClick={() => acknowledge(noSourceId)}>
          Количество верное
        </Button>
      </>,
    );
  }

  const priceText = (i: AttentionItem): string => {
    const g = i.groupKey ? d.res.groups.find((x) => x.key === i.groupKey) : undefined;
    if (!g) return i.title;
    const label = materialText(g.material.id, g.t);
    if (i.kind === 'priceEstimate') return `${label}: цена — оценка (нет на mc.ru)`;
    const at = pairFetchedAt(book, g.material.id, g.t);
    return at ? `${label}: цена от ${dateDay(at)}` : i.title;
  };

  return (
    <section aria-labelledby="before-send-title" className="flex flex-col gap-2">
      <h3 id="before-send-title" className="text-sm font-semibold">
        Перед отправкой
      </h3>
      <ul className="space-y-1.5 text-sm">
        {qty}

        {problems.map((i) => (
          <Row key={i.id} icon={<OctagonAlert className="text-danger" />}>
            <span className="sr-only">ошибка: </span>
            <LinkRow onClick={() => openItem(i)}>{i.title}</LinkRow>
          </Row>
        ))}

        {checks.length > 0 && (
          <Row icon={<TriangleAlert className="text-warn" />}>
            <div className="flex flex-wrap items-center gap-x-2">
              <span>
                Ещё {checks.length} {plural(checks.length, 'пункт', 'пункта', 'пунктов')} проверить
              </span>
              <Button variant="link" size="xs" className="h-auto px-0" onClick={() => startTriage()}>
                Проверить по очереди
              </Button>
            </div>
          </Row>
        )}

        {prices.map((i) => (
          <Row key={i.id} icon={<TriangleAlert className="text-warn" />}>
            <LinkRow onClick={() => setTab('prices')}>{priceText(i)}</LinkRow>
          </Row>
        ))}

        {questions > 0 && !withQuestions && (
          <Row icon={<Info className="text-muted-foreground" />}>
            <div className="flex flex-wrap items-center gap-x-2">
              <span>
                {questions} {plural(questions, 'вопрос', 'вопроса', 'вопросов')} клиенту {plural(questions, 'не включён', 'не включены', 'не включены')}
              </span>
              <Button variant="link" size="xs" className="h-auto px-0" onClick={() => setQuoteQuestions(true)}>
                Включить
              </Button>
            </div>
          </Row>
        )}

        {open.length === 0 && qtyOk && pending === 0 && (
          <Row icon={<CircleCheck className="text-ok" />} className="font-medium">
            Всё проверено — можно отправлять клиенту
          </Row>
        )}
      </ul>
      <p className="mt-1 flex items-start gap-2 rounded-md bg-muted px-2.5 py-2 text-xs text-muted-foreground">
        <Lock aria-hidden className="mt-px size-3.5 shrink-0" />
        <span>
          Только для вас: себестоимость {rub0(q.cost)} · выручка {rub0(q.revenue)} · маржа {pct1(q.marginPct)}
        </span>
      </p>
    </section>
  );
}
