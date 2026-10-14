import type { OrderResult } from '../core/pricing.ts';
import { n0, n1, pct, plural, rub0 } from '../format.ts';
import type { Order } from '../order.ts';
import { CATS, CostBar, type CatKey } from './CostBar.tsx';
import { NumInput } from './NumInput.tsx';

interface Props {
  res: OrderResult;
  order: Order;
  vatPct: number;
  onOrder: (patch: Partial<Order>) => void;
}

export function SummaryStrip({ res, order, vatPct, onOrder }: Props) {
  const T = res.totals;
  const parts: Record<CatKey, number> = {
    material: T.material,
    cut: T.cutting,
    bend: T.bending,
    extras: T.extras,
    delivery: T.delivery,
  };
  const base = T.cost || 1;
  const sheets = res.groups.reduce((a, g) => a + g.chosen.sheetsCharged, 0);
  const positions = order.positions.filter((p) => !p.disabled).length;

  return (
    <section className="card summary" aria-label="Итог заказа">
      <div className="sum-total">
        <div className="eyebrow">Итого по заказу</div>
        <div className="big-number">{rub0(T.total)}</div>
        <div className="muted small">
          в т.ч. НДС {vatPct}% — {rub0(T.vat)}
          {T.markup > 0 && (
            <>
              <br />
              себестоимость {rub0(T.cost)} + наценка {rub0(T.markup)}
            </>
          )}
        </div>
      </div>

      <div className="sum-split">
        <CostBar parts={parts} height={14} />
        <table className="sum-legend">
          <tbody>
            {CATS.map((c) => {
              const v = parts[c.key];
              if (!v && c.key !== 'material' && c.key !== 'cut') return null;
              return (
                <tr key={c.key}>
                  <td>
                    <span className="dot" style={{ background: c.color }} />
                    {c.label}
                  </td>
                  <td className="r strong">{rub0(v)}</td>
                  <td className="r muted">{pct(v / base)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="sum-controls">
        <label>
          <span>Наценка</span>
          <NumInput value={order.markupPct} onChange={(v) => onOrder({ markupPct: v })} suffix="%" width={56} />
        </label>
        <label>
          <span>Доставка</span>
          <NumInput value={order.delivery} onChange={(v) => onOrder({ delivery: v })} suffix="₽" width={80} />
        </label>
      </div>

      <div className="sum-stats">
        <span>
          <b>{positions}</b> {plural(positions, 'позиция', 'позиции', 'позиций')}
        </span>
        <span>
          <b>{n0(T.pieces)}</b> шт
        </span>
        <span>
          <b>{n0(T.kg)}</b> кг металла в деталях
        </span>
        <span>
          рез <b>{n0(T.cutM)}</b> м
        </span>
        <span>
          <b>{n0(T.bends)}</b> {plural(T.bends, 'гиб', 'гиба', 'гибов')}
        </span>
        <span>
          <b>{n1(sheets)}</b> {plural(Math.ceil(sheets), 'лист', 'листа', 'листов')} в раскрое
        </span>
      </div>
    </section>
  );
}
