// Список «Требует внимания» по разделам (порядок — SECTION_TITLE): закрытые скрыты, «Изменено ИИ» свёрнуто,
// одинаковые предложения ИИ для нескольких позиций — одной строкой «… — 2 поз.» с «Принять для 2».
import { useState, type ReactElement, type ReactNode } from 'react';
import { SECTION_TITLE, type AttentionItem, type OfferGroup, type SectionId } from '@/attention.ts';
import { cn } from '@/lib/utils.ts';
import { Button } from '@/components/ui/button.tsx';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible.tsx';
import { ChevronDown, ChevronRight, Sparkles } from '@/components/common/icons.ts';
import { openPosition } from '@/store/actions.ts';
import { acceptSuggestions, rejectSuggestions } from '@/store/aiActions.ts';
import { useDerived } from '@/store/derived.tsx';
import { useStore } from '@/store/store.ts';
import { AttentionItemView } from './AttentionItemView.tsx';

function SectionHead({ children }: { children: ReactNode }): ReactElement {
  return <h4 className="mt-3 mb-0.5 text-xs font-medium text-muted-foreground first:mt-0">{children}</h4>;
}

function OfferGroupRow({ g }: { g: OfferGroup }): ReactElement {
  const [open, setOpen] = useState(false);
  const names = useStore((s) => s.order.positions);
  const n = g.positionIds.length;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="py-1.5">
      <div className="flex items-start gap-2">
        <Sparkles aria-hidden className="mt-0.5 size-3.5 shrink-0 text-ai" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] leading-snug font-medium">{g.title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <Button variant="outline" size="xs" className="text-ai hover:text-ai" onClick={() => acceptSuggestions(g.suggestionIds)}>
              Принять для {n}
            </Button>
            <Button variant="ghost" size="xs" onClick={() => rejectSuggestions(g.suggestionIds)}>
              Отклонить
            </Button>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="xs" className="text-muted-foreground" aria-label={open ? 'Скрыть позиции' : 'Показать позиции'}>
                {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
                Позиции
              </Button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            <ul className="mt-1 space-y-0.5 text-xs">
              {g.positionIds.map((id) => (
                <li key={id}>
                  <button
                    type="button"
                    className="focus-ring rounded-sm text-left underline-offset-2 hover:underline"
                    onClick={() => openPosition(id, { reveal: true, focus: 'ai' })}
                  >
                    {names.find((p) => p.id === id)?.name ?? id}
                  </button>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </div>
      </div>
    </Collapsible>
  );
}

function Items({ items, current }: { items: AttentionItem[]; current: string | null }): ReactElement {
  return (
    <>
      {items.map((it) => (
        <AttentionItemView key={it.id} item={it} current={it.id === current} />
      ))}
    </>
  );
}

export function AttentionList(): ReactElement | null {
  const { attention } = useDerived();
  const triage = useStore((s) => s.ui.triage);
  const [autoOpen, setAutoOpen] = useState(false);
  const current = triage ? (triage.ids[triage.index] ?? null) : null;
  const grouped = new Set(attention.offerGroups.flatMap((g) => g.suggestionIds.map((id) => `offer:${id}`)));
  const sections = attention.sections.filter((s) => s.id !== 'offers');
  const offers = attention.sections.find((s) => s.id === 'offers')?.items.filter((x) => !grouped.has(x.id)) ?? [];
  const showOffers = offers.length > 0 || attention.offerGroups.length > 0;
  if (!sections.length && !showOffers) return null;
  return (
    <div className="text-sm">
      {[...(showOffers ? ['offers' as const] : []), ...sections.map((s) => s.id)]
        .sort((a, b) => order(a) - order(b))
        .map((id) => {
          if (id === 'offers') {
            return (
              <section key={id} aria-label={SECTION_TITLE.offers}>
                <SectionHead>{SECTION_TITLE.offers}</SectionHead>
                {attention.offerGroups.map((g) => (
                  <OfferGroupRow key={g.key} g={g} />
                ))}
                <Items items={offers} current={current} />
              </section>
            );
          }
          const sec = sections.find((s) => s.id === id)!;
          if (id === 'auto') {
            return (
              <Collapsible key={id} open={autoOpen} onOpenChange={setAutoOpen} asChild>
                <section aria-label={sec.title}>
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        'focus-ring mt-3 mb-0.5 inline-flex items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {sec.title} ({sec.items.length})
                      {autoOpen ? <ChevronDown aria-hidden className="size-3.5" /> : <ChevronRight aria-hidden className="size-3.5" />}
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <Items items={sec.items} current={current} />
                  </CollapsibleContent>
                </section>
              </Collapsible>
            );
          }
          return (
            <section key={id} aria-label={sec.title}>
              <SectionHead>{sec.title}</SectionHead>
              <Items items={sec.items} current={current} />
            </section>
          );
        })}
    </div>
  );
}

const ORDER = Object.keys(SECTION_TITLE) as SectionId[];
const order = (id: SectionId) => ORDER.indexOf(id);
