// Внутренний расчёт для печати (А4 альбомный, «Печать расчёта (внутр.)»): себестоимость, наценка, выручка,
// разбивка на 1 шт по позициям, металл по группам, итоги анализа ИИ. Клиенту не отдаётся.
import type { ReactElement } from 'react';
import { CATS, type CatKey } from '@/components/common/CostBar.tsx';
import { cn } from '@/lib/utils.ts';
import { kg, n0, n1, n2, NBSP, pct1, rub0, rub2 } from '@/format.ts';
import { clientMoney, materialText, UNPRICED_WORD } from '@/quote.ts';
import { useDerived } from '@/store/derived.tsx';
import { useStore } from '@/store/store.ts';

const SOURCE: Record<string, string> = { mc: 'mc.ru', estimate: 'оценка', manual: 'вручную' };

export function InternalPrint(): ReactElement {
  const d = useDerived();
  const title = useStore((s) => s.order.title.trim());
  const ai = useStore((s) => s.order.ai);
  const q = d.quote;
  const T = d.res.totals;
  const parts: Record<CatKey, number> = { material: T.material, cut: T.cutting, bend: T.bending, extras: T.extras, delivery: T.delivery };
  const breakdown = CATS.filter((c) => parts[c.key] > 0 || c.key === 'material' || c.key === 'cut')
    .map((c) => `${c.label} ${rub0(parts[c.key])}`)
    .join(' · ');
  // позиции без размеров в расчёт денег не входят (нет строки в res), но в таблице остаются — «цена уточняется»
  const rows = d.positions.filter((p) => d.res.positions.has(p.id) || d.unpriced.has(p.id));
  const off = d.positions.length - rows.length;
  const cell = 'border-b border-neutral-300 px-[0.35em] py-[0.25em] align-top';
  const num = cn(cell, 'num text-right tabular-nums whitespace-nowrap');
  const head = 'font-medium text-neutral-600';
  const a = ai?.analysis;
  const clientNum = (v: number) => (q.settings.rounding === 'kop' ? n2(v) : n0(v)); // цены клиенту — как в КП

  return (
    <article className="leading-snug text-neutral-900">
      <p className="avoid-break mb-[0.8em] inline-block border-2 border-neutral-900 px-[0.6em] py-[0.2em] font-semibold tracking-wide uppercase">
        Внутренний расчёт — не для клиента
      </p>
      <h1 className="text-[1.5em] leading-tight font-semibold">{title || 'Расчёт заказа'}</h1>
      <p className="text-neutral-600">{q.date}</p>
      <p className="mt-[0.6em] font-medium">
        Себестоимость {clientMoney(q, q.cost)} · Наценка {n1(q.markupPct)}
        {NBSP}% · Цена клиенту {clientMoney(q, q.total)} · Выручка {clientMoney(q, q.revenue)} · маржа {pct1(q.marginPct)} · НДС {rub2(q.vat)}
      </p>
      <p className="text-neutral-700">{breakdown}</p>
      <p className="text-neutral-600">
        {rows.length} поз. · {n0(T.pieces)}
        {NBSP}шт · {kg(T.kg)} металла в деталях · рез {n1(T.cutM)}
        {NBSP}м · гибов {n0(T.bends)}
        {off > 0 ? ` · не в расчёте: ${off}` : ''}
        {q.unpriced > 0 ? ` · без размеров (цена уточняется): ${q.unpriced}` : ''}
      </p>

      <table className="mt-[0.8em] w-full border-collapse text-[0.85em]">
        <thead>
          <tr className="text-left">
            <th className={cn(cell, head)}>№</th>
            <th className={cn(cell, head)}>Обозначение</th>
            <th className={cn(cell, head)}>Материал</th>
            <th className={cn(num, head)}>Кол-во</th>
            <th className={cn(num, head)}>Габарит</th>
            <th className={cn(num, head)}>Масса шт</th>
            <th className={cn(num, head)}>Рез шт</th>
            <th className={cn(num, head)}>Гибов</th>
            <th className={cn(num, head)}>Металл/шт</th>
            <th className={cn(num, head)}>Резка/шт</th>
            <th className={cn(num, head)}>Гибка/шт</th>
            <th className={cn(num, head)}>Доп./шт</th>
            <th className={cn(num, head)}>Себест./шт</th>
            <th className={cn(num, head)}>Цена/шт</th>
            <th className={cn(num, head)}>Сумма</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => {
            const r = d.res.positions.get(p.id);
            const l = q.linesById.get(p.id);
            if (!r) {
              return (
                <tr key={p.id}>
                  <td className={cn(cell, 'tabular-nums')}>{i + 1}</td>
                  <td className={cn(cell, 'break-words')}>{p.name}</td>
                  <td className={cell}>{materialText(p.materialId, p.thickness)}</td>
                  <td className={num}>{p.qty}</td>
                  <td className={num}>{p.geom.width > 0 ? `${Math.round(p.geom.width)}×${Math.round(p.geom.height)}` : '—'}</td>
                  <td colSpan={2} className={cn(cell, 'text-neutral-600')}>
                    нет размеров
                  </td>
                  <td className={num}>{p.bends}</td>
                  <td colSpan={7} className={cn(cell, 'text-right text-neutral-600')}>
                    {UNPRICED_WORD}
                  </td>
                </tr>
              );
            }
            return (
              <tr key={p.id}>
                <td className={cn(cell, 'tabular-nums')}>{i + 1}</td>
                <td className={cn(cell, 'break-words')}>{p.name}</td>
                <td className={cell}>{materialText(p.materialId, p.thickness)}</td>
                <td className={num}>{p.qty}</td>
                <td className={num}>{p.geom.width > 0 ? `${Math.round(p.geom.width)}×${Math.round(p.geom.height)}` : '—'}</td>
                <td className={num}>{n2(r.netKg)}</td>
                <td className={num}>{n2(r.cutM)}</td>
                <td className={num}>{p.bends}</td>
                <td className={num}>{n2(r.piece.material)}</td>
                <td className={num}>{n2(r.piece.cut + r.piece.pierce)}</td>
                <td className={num}>{n2(r.piece.bend)}</td>
                <td className={num}>{n2(r.piece.extras)}</td>
                <td className={num}>{n2(r.piece.total)}</td>
                <td className={num}>{l?.price != null ? clientNum(l.price) : '—'}</td>
                <td className={num}>{l?.sum != null ? clientNum(l.sum) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          {q.delivery > 0 && (
            <tr>
              <td colSpan={14} className={cn(cell, 'text-right')}>
                Доставка (себестоимость {rub0(T.delivery)})
              </td>
              <td className={num}>{clientMoney(q, q.delivery)}</td>
            </tr>
          )}
          <tr className="font-semibold">
            <td colSpan={14} className={cn(cell, 'text-right')}>
              Цена клиенту (как в КП)
            </td>
            <td className={num}>{clientMoney(q, q.total)}</td>
          </tr>
        </tfoot>
      </table>

      {d.res.groups.length > 0 && (
        <div className="avoid-break mt-[1em]">
          <h2 className="mb-[0.3em] font-semibold">Металл по группам</h2>
          <table className="w-full border-collapse text-[0.85em]">
            <thead>
              <tr className="text-left">
                <th className={cn(cell, head)}>Материал</th>
                <th className={cn(num, head)}>Позиций</th>
                <th className={cn(num, head)}>Масса деталей</th>
                <th className={cn(cell, head)}>Лист</th>
                <th className={cn(num, head)}>₽/кг</th>
                <th className={cn(cell, head)}>Цена</th>
                <th className={cn(num, head)}>Листов</th>
                <th className={cn(num, head)}>Металл</th>
              </tr>
            </thead>
            <tbody>
              {d.res.groups.map((g) => (
                <tr key={g.key}>
                  <td className={cell}>{materialText(g.material.id, g.t)}</td>
                  <td className={num}>{g.positionIds.length}</td>
                  <td className={num}>{kg(g.partsKg)}</td>
                  <td className={cell}>
                    {g.chosen.offer.w}×{g.chosen.offer.l}
                    {g.autoChosen ? '' : ' (выбран вручную)'}
                  </td>
                  <td className={num}>{n2(g.chosen.offer.pricePerKg)}</td>
                  <td className={cell}>{SOURCE[g.chosen.offer.source] ?? g.chosen.offer.source}</td>
                  <td className={num}>{n1(g.chosen.sheetsCharged)}</td>
                  <td className={num}>{rub0(g.materialCost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {a && (
        <div className="mt-[1em] space-y-[0.6em]">
          <div className="avoid-break">
            <h2 className="font-semibold">Анализ ИИ</h2>
            <p>{a.summary}</p>
          </div>
          {a.questions.length > 0 && (
            <div className="avoid-break">
              <h2 className="font-semibold">Вопросы клиенту</h2>
              <ol className="list-decimal pl-[1.6em]">
                {a.questions.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </div>
          )}
          {a.risks.length > 0 && (
            <div className="avoid-break">
              <h2 className="font-semibold">Риски</h2>
              <ul className="list-disc pl-[1.6em]">
                {a.risks.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
