// КП для клиента (ui-spec §7.1): один и тот же компонент — превью на вкладке «Для клиента» и печать (Ctrl+P).
// Только то, что видит клиент: никакой себестоимости, наценки, маржи, выручки, отметок ИИ, статусов и «mc.ru».
// Размеры шрифта — в em: на экране основа 13 px, в печати — 10 pt (print.css).
import type { ReactElement } from 'react';
import { PartPreview } from '@/components/common/PartPreview.tsx';
import { cn } from '@/lib/utils.ts';
import { n0, n2, NBSP } from '@/format.ts';
import { amountInWords } from '@/numberWords.ts';
import { clientMoney, UNPRICED_NOTE, UNPRICED_WORD, workDays, type Quote } from '@/quote.ts';
import { useDerived } from '@/store/derived.tsx';
import { useStore } from '@/store/store.ts';

export interface QuoteDocumentProps {
  variant: 'screen' | 'print';
}

/** «Цены с НДС 22 %. Действительны 5 рабочих дней. Стоимость металла — на 16.10.2026.» */
function printValidity(q: Quote): string {
  const days = Math.max(0, Math.round(q.settings.validityDays || 0));
  return [
    `Цены с НДС ${q.vatPct}${NBSP}%.`,
    days > 0 ? `Действительны ${workDays(days)}.` : '',
    q.metalDate ? `Стоимость металла — на ${q.metalDate}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function QuoteDocument({ variant }: QuoteDocumentProps): ReactElement {
  const d = useDerived();
  const withQuestions = useStore((s) => s.ui.quoteQuestions);
  const ai = useStore((s) => s.order.ai);
  const q = d.quote;
  const qs = q.settings;
  const kop = qs.rounding === 'kop';
  const num = (v: number) => (kop ? n2(v) : n0(v));
  const questions = withQuestions && ai ? ai.analysis.questions.map((x) => x.trim()).filter(Boolean) : [];
  const sketch = qs.showSketch;
  const material = qs.showMaterial;
  const cols = 5 + (sketch ? 1 : 0) + (material ? 1 : 0);
  const header = qs.header.trim();
  const terms = qs.terms.trim();
  const signature = qs.signature.trim();
  const screen = variant === 'screen';
  const cell = 'border-b border-neutral-300 px-[0.45em] py-[0.35em] align-top';
  const numCell = cn(cell, 'num text-right tabular-nums whitespace-nowrap');

  return (
    <article
      aria-label={screen ? 'КП — как будет напечатано' : undefined}
      className={cn('quote-doc leading-snug text-neutral-900', screen && 'min-w-[600px] text-[13px]')}
    >
      <header className={cn('mb-[1.6em] flex items-start gap-6', header ? 'justify-between' : 'justify-end')}>
        {header && <div className="min-w-0 whitespace-pre-line">{header}</div>}
        <div className="shrink-0 text-right tabular-nums">{q.date}</div>
      </header>

      <h1 className="text-[1.7em] leading-tight font-semibold">Коммерческое предложение</h1>
      <p className="mt-[0.3em]">на изготовление деталей: {q.works}</p>
      {q.title && <p className="mt-[0.15em]">Заказ: {q.title}</p>}

      <table className="mt-[1.2em] w-full border-collapse">
        <thead>
          <tr className="text-left text-[0.92em] text-neutral-600">
            <th className={cn(cell, 'w-[2.2em] font-medium')}>№</th>
            {sketch && <th className={cn(cell, 'w-[14mm] font-medium')}>Эскиз</th>}
            <th className={cn(cell, 'font-medium')}>Наименование</th>
            {material && <th className={cn(cell, 'font-medium')}>Материал</th>}
            <th className={cn(numCell, 'font-medium')}>Кол-во</th>
            <th className={cn(numCell, 'font-medium')}>Цена, ₽</th>
            <th className={cn(numCell, 'font-medium')}>Сумма, ₽</th>
          </tr>
        </thead>
        <tbody>
          {q.lines.map((l) => {
            const p = d.byId.get(l.positionId);
            return (
              <tr key={l.positionId}>
                <td className={cn(cell, 'tabular-nums')}>{l.n}</td>
                {sketch && (
                  <td className={cn(cell, 'py-[0.2em]')}>
                    {p?.preview?.outer.length ? <PartPreview preview={p.preview} className="h-[9mm] w-[12mm]" /> : null}
                  </td>
                )}
                <td className={cell}>
                  <div className="break-words">{l.name}</div>
                  {l.note && <div className="text-[0.85em] text-neutral-600">{l.note}</div>}
                </td>
                {material && <td className={cell}>{l.material}</td>}
                <td className={numCell}>
                  {l.qty}
                  {NBSP}шт
                </td>
                {l.price == null || l.sum == null ? (
                  <td colSpan={2} className={cn(cell, 'text-right whitespace-nowrap text-neutral-600 italic')}>
                    {UNPRICED_WORD}
                  </td>
                ) : (
                  <>
                    <td className={numCell}>{num(l.price)}</td>
                    <td className={numCell}>{num(l.sum)}</td>
                  </>
                )}
              </tr>
            );
          })}
          {q.delivery > 0 && (
            <tr>
              <td className={cell} />
              <td colSpan={cols - 2} className={cell}>
                Доставка
              </td>
              <td className={numCell}>{num(q.delivery)}</td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            <td colSpan={cols - 1} className={cn(cell, 'border-b-0 pt-[0.6em] text-right')}>
              Итого:
            </td>
            <td className={cn(numCell, 'border-b-0 pt-[0.6em] text-[1.08em]')}>{num(q.total)}</td>
          </tr>
          <tr>
            <td colSpan={cols - 1} className={cn(cell, 'border-b-0 text-right')}>
              В том числе НДС {q.vatPct}
              {NBSP}%:
            </td>
            <td className={cn(numCell, 'border-b-0')}>{n2(q.vat)}</td>
          </tr>
        </tfoot>
      </table>

      <div className="avoid-break mt-[1.2em] space-y-[0.4em]">
        <p>
          Всего наименований {q.lines.length} на сумму <b className="font-semibold">{clientMoney(q, q.total)}</b>
          {qs.amountInWords && <span className="block">({amountInWords(q.total)})</span>}
        </p>
        {q.unpriced > 0 && <p>{UNPRICED_NOTE}</p>}
        <p>{printValidity(q)}</p>
        {terms && <p className="whitespace-pre-line">{terms}</p>}
      </div>

      {questions.length > 0 && (
        <div className="avoid-break mt-[1.2em]">
          <p className="font-semibold">Просим уточнить:</p>
          <ol className="mt-[0.3em] list-decimal space-y-[0.2em] pl-[1.6em]">
            {questions.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </div>
      )}

      {signature && <p className="avoid-break mt-[2em] whitespace-pre-line">{signature}</p>}
    </article>
  );
}
