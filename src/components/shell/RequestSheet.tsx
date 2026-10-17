// Панель «Заявка и документы» (ui-spec §2.14): ход расчёта, заявка клиента, документы, строки заявки без чертежа,
// журнал загрузки. Открывается на нужном разделе (пилюли этапов, «Подробнее» в уведомлениях, меню «Ещё»).
import { useEffect, useMemo, useRef, type ReactElement, type ReactNode } from 'react';
import { cn } from '@/lib/utils.ts';
import { Button } from '@/components/ui/button.tsx';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible.tsx';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { ChevronDown, Plus, Trash2 } from '@/components/common/icons.ts';
import { isEditable } from '@/components/common/dom.ts';
import { AI_LIMITS } from '@/core/ai.ts';
import { hhmm, n0 } from '@/format.ts';
import type { JournalEntry } from '@/order.ts';
import { desigKey } from '@/pdfImport.ts';
import { closeSheet, openDialog, removeDocument } from '@/store/actions.ts';
import { setRequest } from '@/store/pipelineActions.ts';
import { useStore } from '@/store/store.ts';
import type { RequestSection } from '@/store/types.ts';
import { JournalIcon, RequestCounter } from './EmptyScreen.tsx';
import { StageList } from './StageList.tsx';

function Section({ id, title, children, className }: { id: RequestSection; title: ReactNode; children: ReactNode; className?: string }): ReactElement {
  return (
    <section id={`request-${id}`} aria-labelledby={`request-${id}-title`} className={cn('scroll-mt-2 border-b py-4 last:border-b-0', className)}>
      <h3 id={`request-${id}-title`} tabIndex={-1} className="mb-2 text-sm font-semibold outline-none">
        {title}
      </h3>
      {children}
    </section>
  );
}

function RequestEditor(): ReactElement {
  const request = useStore((s) => s.order.request ?? '');
  const hasAi = useStore((s) => !!s.order.ai);
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        id="request-sheet-input"
        aria-label="Заявка клиента"
        value={request}
        onChange={(e) => setRequest(e.target.value)}
        placeholder="Вставьте текст письма: «Прошу счёт… БВС-305Х300.000 — 3 шт»"
        className="max-h-[45dvh] min-h-52 resize-y overflow-y-auto"
        spellCheck={false}
      />
      <div className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
        <div className="flex flex-col gap-0.5">
          {request.length > AI_LIMITS.requestChars && <span className="text-warn">В анализ уйдут первые {n0(AI_LIMITS.requestChars)} символов</span>}
          {hasAi && <span>После правки анализ ИИ будет помечен устаревшим.</span>}
        </div>
        <RequestCounter len={request.length} />
      </div>
    </div>
  );
}

function Documents(): ReactElement {
  const docs = useStore((s) => s.order.documents ?? []);
  if (!docs.length) return <p className="text-muted-foreground">Документов нет — тексты .txt и листы PDF без чертежа попадут сюда.</p>;
  return (
    <ul className="flex flex-col gap-1">
      {docs.map((d) => (
        <Collapsible key={d.fileName} asChild>
          <li className="rounded-lg border">
            <div className="flex items-center gap-2 py-1 pr-1 pl-3">
              <span className="min-w-0 flex-1 truncate" title={d.fileName}>
                {d.fileName} <span className="text-muted-foreground tabular-nums">· {n0(d.text.length)} симв.</span>
              </span>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="xs" className="group/doc">
                  Показать
                  <ChevronDown data-icon="inline-end" className="transition-transform group-data-[state=open]/doc:rotate-180" />
                </Button>
              </CollapsibleTrigger>
              <Button variant="ghost" size="xs" onClick={() => removeDocument(d.fileName)}>
                <Trash2 data-icon="inline-start" />
                Убрать из заказа
              </Button>
            </div>
            <CollapsibleContent>
              <pre className="mx-3 mb-3 max-h-64 overflow-auto rounded-md bg-muted p-2 font-sans text-xs whitespace-pre-wrap">{d.text}</pre>
            </CollapsibleContent>
          </li>
        </Collapsible>
      ))}
    </ul>
  );
}

/** Строки заявок из PDF, для которых нет чертежа в заказе */
function useMissingLines() {
  const lines = useStore((s) => s.order.requestLines);
  const positions = useStore((s) => s.order.positions);
  return useMemo(() => {
    const have = new Set(positions.map((p) => desigKey(p.name)));
    return (lines ?? []).filter((l) => !have.has(desigKey(l.designation)));
  }, [lines, positions]);
}

function Missing({ lines }: { lines: ReturnType<typeof useMissingLines> }): ReactElement {
  return (
    <ul className="flex flex-col gap-1">
      {lines.map((l, i) => (
        <li key={`${l.designation}-${i}`} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate tabular-nums">
            {l.designation} — {l.qty} шт
          </span>
          <Button variant="outline" size="xs" onClick={() => openDialog({ kind: 'manual', prefill: { name: l.designation, qty: l.qty } })}>
            <Plus data-icon="inline-start" />
            Добавить деталь
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** Журнал: новые записи сверху; записи одной загрузки — в своём порядке */
function Journal(): ReactElement {
  const journal = useStore((s) => s.order.journal);
  const rows = useMemo(() => {
    const groups: JournalEntry[][] = [];
    for (const e of journal ?? []) {
      const last = groups.at(-1);
      if (last && last[0].at === e.at) last.push(e);
      else groups.push([e]);
    }
    return groups.reverse().flat();
  }, [journal]);
  if (!rows.length) return <p className="text-muted-foreground">Пока пусто</p>;
  return (
    <ol className="flex flex-col gap-1 text-[13px]">
      {rows.map((e, i) => (
        <li key={i} className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-start gap-2">
          <time dateTime={e.at} className="text-muted-foreground tabular-nums">
            {hhmm(e.at)}
          </time>
          <JournalIcon level={e.level} />
          <span className={cn(e.level === 'error' && 'text-danger')}>{e.text}</span>
        </li>
      ))}
    </ol>
  );
}

function RequestSheetBody({ section }: { section?: RequestSection }): ReactElement {
  const docs = useStore((s) => (s.order.documents ?? []).length);
  const missing = useMissingLines();
  // открылась на разделе — прокрутить к нему и поставить на него фокус; «Заявка клиента» — сразу в поле (вставить письмо)
  useEffect(() => {
    if (!section || section === 'stages') return;
    const t = setTimeout(() => {
      const el = document.getElementById(`request-${section}`);
      el?.scrollIntoView({ block: 'start' });
      const target = section === 'request' ? 'request-sheet-input' : `request-${section}-title`;
      document.getElementById(target)?.focus({ preventScroll: true });
    }, 60);
    return () => clearTimeout(t);
  }, [section]);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
      <Section id="stages" title="Ход расчёта">
        <StageList actions />
      </Section>
      <Section id="request" title="Заявка клиента">
        <RequestEditor />
      </Section>
      <Section id="documents" title={`Документы (${docs})`}>
        <Documents />
      </Section>
      {missing.length > 0 && (
        <Section id="missing" title={`В заявке без чертежа (${missing.length})`}>
          <Missing lines={missing} />
        </Section>
      )}
      <Section id="journal" title="Журнал загрузки">
        <Journal />
      </Section>
    </div>
  );
}

export function RequestSheet(): ReactElement | null {
  const sheet = useStore((s) => s.ui.sheet);
  const opener = useRef<HTMLElement | null>(null);
  if (sheet?.kind !== 'request') return null;
  return (
    <Sheet open onOpenChange={(o) => !o && closeSheet()}>
      <SheetContent
        side="right"
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-140"
        onEscapeKeyDown={(e) => {
          // Esc в поле — сначала уйти из поля, следующий Esc закроет панель
          if (!isEditable(e.target)) return;
          e.preventDefault();
          const el = e.target as HTMLElement;
          setTimeout(() => el.blur(), 0);
        }}
        // фокус — на заголовок панели, а не на первую кнопку («Обновить цены» в ходе расчёта): та прокручивала
        // начало панели из виду. Раздел, на котором открыли, получает фокус следом (RequestSheetBody)
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          const a = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          // открыли пунктом меню — вернуть фокус на кнопку меню: самого пункта к закрытию панели уже не будет
          const menu = a?.closest<HTMLElement>('[role=menu]');
          opener.current = (menu && document.getElementById(menu.getAttribute('aria-labelledby') ?? '')) || a;
          (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>('[data-slot=sheet-title]')?.focus({ preventScroll: true });
        }}
        // панель открывают из хранилища (меню, пилюли, «Перед отправкой») — фокус обратно туда, откуда открыли
        onCloseAutoFocus={(e) => {
          const el = opener.current;
          opener.current = null;
          if (!el?.isConnected) return;
          e.preventDefault();
          el.focus({ preventScroll: true });
        }}
      >
        <SheetHeader className="border-b pr-12">
          <SheetTitle tabIndex={-1} className="outline-none">
            Заявка и документы
          </SheetTitle>
          <SheetDescription>Ход расчёта, заявка клиента, документы и журнал загрузки</SheetDescription>
        </SheetHeader>
        <RequestSheetBody key={sheet.section ?? 'stages'} section={sheet.section} />
      </SheetContent>
    </Sheet>
  );
}
