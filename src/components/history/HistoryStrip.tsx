// Полоса «История» на экране результата: сохранён ли заказ в общей истории, изменён ли после сохранения,
// счёт цеха (факт против нашего расчёта) и сколько деталей уже встречались в прошлых заказах.
import { useMemo, type ReactElement } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { History, Loader2 } from '@/components/common/icons.ts';
import { Money } from '@/components/common/Money.tsx';
import { bestSame } from '@/core/history.ts';
import { dateShort, plural } from '@/format.ts';
import { historyHash } from '@/history/build.ts';
import { invoiceDocument } from '@/history/invoicePdf.ts';
import { useDerived } from '@/store/derived.tsx';
import { editInvoice, invoiceForCurrent, openHistory, saveToHistory } from '@/store/historyActions.ts';
import { useStore } from '@/store/store.ts';
import { DiffBadge, invoiceTitle, supplierName } from './shared.tsx';

export function HistoryStrip(): ReactElement | null {
  const order = useStore((s) => s.order);
  const live = useStore((s) => s.prices.live);
  const available = useStore((s) => s.history.available);
  const busy = useStore((s) => s.history.busy);
  const matches = useStore((s) => s.history.matches);
  const d = useDerived();
  const ref = order.history;
  const changed = useMemo(() => !!ref && historyHash(order, d.positions) !== ref.hash, [order, d.positions, ref]);
  const docInvoice = useMemo(() => invoiceDocument(order.documents), [order.documents]);
  const repeated = useMemo(() => d.positions.filter((p) => !p.disabled && bestSame(matches[p.id])), [d.positions, matches]);
  if (!live || available === false) return null; // статическая версия без сервера — истории нет

  const inv = ref?.invoice;
  const saving = !!busy;
  return (
    <section aria-label="История заказов" className="no-print flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card px-4 py-2.5 text-sm">
      <History aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
        {!ref ? (
          <span>
            <span className="font-medium">Заказ не в истории</span>
            <span className="text-muted-foreground"> — сохраните: его увидят коллеги, а когда придёт счёт цеха, расчёт сверится с фактом</span>
          </span>
        ) : (
          <span className="whitespace-nowrap">
            <span className="font-medium">В истории</span>
            <span className="text-muted-foreground"> · {dateShort(ref.savedAt)}</span>
            {changed && <span className="text-warn"> · изменён после сохранения</span>}
          </span>
        )}
        {inv && (
          <span className="flex flex-wrap items-center gap-x-1.5">
            <span className="text-muted-foreground">
              Счёт {invoiceTitle(inv)}
              {inv.supplier ? ` · ${supplierName(inv.supplier)}` : ''}:
            </span>
            {inv.fact ? (
              <>
                <Money value={inv.fact} className="font-medium" />
                <span className="text-muted-foreground">· расчёт</span>
                <Money value={inv.calc ?? null} />
                <DiffBadge calc={inv.calc} fact={inv.fact} />
              </>
            ) : (
              <span className="text-warn">строки не отнесены к деталям</span>
            )}
          </span>
        )}
        {repeated.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="cursor-default text-muted-foreground underline decoration-dotted underline-offset-2">
                {repeated.length} {plural(repeated.length, 'деталь', 'детали', 'деталей')} уже {plural(repeated.length, 'была', 'были', 'были')} в прошлых заказах
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-80">
              {repeated
                .slice(0, 8)
                .map((p) => p.name)
                .join(', ')}
              {repeated.length > 8 ? ` и ещё ${repeated.length - 8}` : ''}. Прошлые цены — в строке позиции (значок ↺) и в её карточке.
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {(!ref || changed) && (
          <Button size="sm" onClick={() => void saveToHistory()} disabled={saving} title={ref ? 'Перезаписать сохранённый заказ (счёт цеха остаётся)' : undefined}>
            {saving && <Loader2 className="animate-spin" data-icon="inline-start" />}
            {!ref ? 'Сохранить в историю' : 'Обновить в истории'}
          </Button>
        )}
        {ref && changed && (
          <Button size="sm" variant="outline" onClick={() => void saveToHistory({ asNew: true })} disabled={saving} title="Повторный заказ: прежний остаётся в истории как был, этот — отдельной записью без счёта">
            Сохранить как новый
          </Button>
        )}
        {docInvoice && !inv ? (
          <Button size="sm" variant="outline" disabled={saving} onClick={() => void invoiceForCurrent(docInvoice)} title={`Счёт найден в файлах заказа: ${docInvoice.doc.fileName}`}>
            Внести счёт {invoiceTitle(docInvoice.inv)}
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={saving} onClick={() => void invoiceForCurrent()}>
            {inv ? 'Заменить счёт…' : 'Внести счёт цеха…'}
          </Button>
        )}
        {inv && ref && (
          <Button size="sm" variant="ghost" onClick={() => void editInvoice(ref.id)}>
            Сверка по строкам
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => openHistory()}>
          Вся история
        </Button>
      </div>
    </section>
  );
}
