import { useState } from 'react';
import type { SheetPolicy } from '../core/materials.ts';
import { fmtSheet, type GroupResult, type OrderResult, type Settings } from '../core/pricing.ts';
import { mcUrl } from '../mcUrl.ts';
import { kg, n0, n1, n2, pct, rub0, thick } from '../format.ts';
import type { Order, OrderPosition } from '../order.ts';
import { NumInput } from './NumInput.tsx';

interface Props {
  res: OrderResult;
  order: Order;
  settings: Settings;
  onOrder: (patch: Partial<Order>) => void;
  onSettings: (patch: Partial<Settings>) => void;
  highlight: string | null;
  onHighlight: (id: string | null) => void;
}

const POLICY_LABEL: Record<SheetPolicy, string> = {
  length: 'по раскрою (остаток — деловой)',
  whole: 'целыми листами',
  bbox: 'по габариту деталей + отход',
};

export function SheetsSection(props: Props) {
  const { res, order } = props;
  if (!res.groups.length) return null;
  const byId = new Map(order.positions.map((p) => [p.id, p]));
  return (
    <section className="sheets">
      <h2>Металл и раскрой</h2>
      <p className="muted small section-hint">
        Детали одного материала и толщины укладываются на листы по габаритам (оценка сверху — реальный раскрой по контуру плотнее). Стоимость металла группы делится
        между деталями пропорционально габаритной площади.
      </p>
      <MaterialSummary res={res} />
      <div className="groups">
        {res.groups.map((g) => (
          <GroupCard key={g.key} g={g} byId={byId} {...props} />
        ))}
      </div>
    </section>
  );
}

const dash = (v: number) => (v ? rub0(v) : '—');

function MaterialSummary({ res }: { res: OrderResult }) {
  return (
    <div className="table-wrap">
      <table className="mtable">
        <thead>
          <tr>
            <th>Материал</th>
            <th className="r">Толщина</th>
            <th className="r">Позиций</th>
            <th className="r">Шт</th>
            <th className="r">Масса деталей</th>
            <th className="r">Металл</th>
            <th className="r">Резка</th>
            <th className="r">Гибка</th>
            <th className="r">Доп.</th>
            <th className="r">Итого</th>
          </tr>
        </thead>
        <tbody>
          {res.groups.map((g) => {
            const ps = g.positionIds.map((id) => res.positions.get(id)!);
            const s = (f: (p: (typeof ps)[number]) => number) => ps.reduce((a, p) => a + f(p), 0);
            return (
              <tr key={g.key}>
                <td>{g.material.label}</td>
                <td className="r">{thick(g.t)}</td>
                <td className="r">{ps.length}</td>
                <td className="r">{n0(s((p) => p.qty))}</td>
                <td className="r">{kg(g.partsKg)}</td>
                <td className="r">{rub0(s((p) => p.sum.material))}</td>
                <td className="r">{rub0(s((p) => p.sum.cut + p.sum.pierce))}</td>
                <td className="r">{dash(s((p) => p.sum.bend))}</td>
                <td className="r">{dash(s((p) => p.sum.extras))}</td>
                <td className="r strong">{rub0(s((p) => p.sum.total))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function GroupCard({ g, byId, order, settings, onOrder, onSettings, highlight, onHighlight }: Props & { g: GroupResult; byId: Map<string, OrderPosition> }) {
  const [showAll, setShowAll] = useState(false);
  const c = g.chosen;
  const sheets = c.nest.sheets;
  const visible = showAll ? sheets : sheets.slice(0, 4);
  const choice = order.sheetChoice[g.key] ?? '';
  const override = order.priceOverride[g.key] ?? 0;
  const setChoice = (v: string) => {
    const next = { ...order.sheetChoice };
    if (v) next[g.key] = v;
    else delete next[g.key];
    onOrder({ sheetChoice: next });
  };
  const setOverride = (v: number) => {
    const next = { ...order.priceOverride };
    if (v > 0) next[g.key] = v;
    else delete next[g.key];
    onOrder({ priceOverride: next });
  };

  return (
    <article className="card group">
      <header>
        <div>
          <h3>
            {g.material.label} · {thick(g.t)}
          </h3>
          <div className="muted small">
            {g.positionIds.length} поз. · детали {kg(g.partsKg)} · по габариту {kg(g.bboxKg)}
          </div>
        </div>
        <div className="group-cost">
          <span className="dot" style={{ background: 'var(--c-metal)' }} />
          {rub0(g.materialCost)}
        </div>
      </header>

      <div className="group-controls">
        <label>
          <span>Лист</span>
          <select value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="">Авто: {fmtSheet(g.auto.offer.w, g.auto.offer.l)}</option>
            {g.options.map((o) => {
              const k = fmtSheet(o.offer.w, o.offer.l);
              return (
                <option key={k} value={k}>
                  {k} — {rub0(o.materialCost)}
                  {Object.keys(o.splits).length ? ' (с разбиением)' : ''}
                </option>
              );
            })}
          </select>
        </label>
        <label>
          <span>Цена</span>
          <NumInput value={override} allowEmpty placeholder={n2(c.offer.pricePerKg)} onChange={setOverride} suffix="₽/кг" width={64} title="Своя цена металла, ₽/кг (пусто — mc.ru)" />
        </label>
        <label>
          <span>Списание</span>
          <select
            value={g.policy}
            onChange={(e) => onSettings({ policy: { ...settings.policy, [g.material.id]: e.target.value as SheetPolicy } })}
            title="Как цех считает металл — для всех позиций этого материала"
          >
            {(Object.keys(POLICY_LABEL) as SheetPolicy[]).map((k) => (
              <option key={k} value={k}>
                {POLICY_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="group-facts small">
        <span>
          {n2(c.offer.pricePerKg)} ₽/кг ·{' '}
          {c.offer.source === 'mc' ? (
            <a href={mcUrl(g.material.mc.category, g.t)} target="_blank" rel="noreferrer">
              {c.offer.note}
            </a>
          ) : (
            <span className={c.offer.source === 'estimate' ? 'warn-text' : ''}>{c.offer.note}</span>
          )}
        </span>
        <span>
          лист {fmtSheet(c.offer.w, c.offer.l)} = {n1(c.sheetKg)} кг = {rub0(c.sheetPrice)}
        </span>
        <span>
          в расчёте <b>{n2(c.sheetsCharged)}</b> листа · заполнение {pct(c.nest.utilization)}
        </span>
      </div>
      {c.capped && (
        <div className="note small">
          {g.policy === 'whole' ? (
            <>
              Целыми листами вышло бы {rub0(Math.ceil(c.nest.sheetsFractional - 1e-9) * c.sheetPrice)} — для такой партии это неправдоподобно, поэтому отход ограничен{' '}
              {settings.maxWasteWholePct ?? 100}% к массе заготовок. Потолок меняется в «Расценках».
            </>
          ) : (
            <>
              По раскрою этого заказа вышло бы {rub0(c.nest.sheetsFractional * c.sheetPrice)}, но отход ограничен {settings.maxWastePct}% к массе заготовок: неудобные детали
              цех обычно докладывает к другим заказам. Потолок меняется в «Расценках».
            </>
          )}
        </div>
      )}
      {Object.keys(c.splits).length > 0 && (
        <div className="note small warn">
          Не помещаются на лист целиком и считаются из частей:{' '}
          {Object.entries(c.splits)
            .map(([id, sp]) => `${byId.get(id)?.name ?? id} — ${sp.pieces} ч.`)
            .join('; ')}
        </div>
      )}

      <div className="sheet-grid">
        {visible.map((s, i) => (
          <figure key={i} className="sheet">
            <svg viewBox={`0 0 ${c.nest.sheetW} ${c.nest.sheetH}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={`Лист ${i + 1}`}>
              <rect x={0} y={0} width={c.nest.sheetW} height={c.nest.sheetH} className="sh-sheet" />
              {i === sheets.length - 1 && g.policy === 'length' && !c.capped && (
                <rect x={0} y={0} width={s.usedLength} height={s.usedWidth} className="sh-used" />
              )}
              {s.placed.map((pl, k) => {
                const pos = byId.get(pl.key);
                return (
                  <rect
                    key={k}
                    x={pl.x}
                    y={pl.y}
                    width={pl.w}
                    height={pl.h}
                    className={`sh-part ${highlight === pl.key ? 'hl' : ''}`}
                    onMouseEnter={() => onHighlight(pl.key)}
                    onMouseLeave={() => onHighlight(null)}
                  >
                    <title>
                      {pos?.name ?? pl.key} — {n0(pl.w)}×{n0(pl.h)} мм
                    </title>
                  </rect>
                );
              })}
            </svg>
            <figcaption className="small muted">
              Лист {i + 1}
              {c.nest.truncated ? '*' : ''} · {s.placed.length} шт
            </figcaption>
          </figure>
        ))}
      </div>
      {sheets.length > 4 && (
        <button className="btn small ghost" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Свернуть' : `Показать все листы (${sheets.length})`}
        </button>
      )}
      {c.nest.truncated && <div className="small muted">* Деталей очень много — раскладка посчитана по пропорциональной выборке.</div>}
    </article>
  );
}
