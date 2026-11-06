// «Как получилась цена за 1 шт»: металл (лист, раскрой, доля детали), резка, гибка, доп. работы и итог с наценкой.
import type { ReactElement, ReactNode } from 'react';
import { CatDot, type CatKey } from '@/components/common/CostBar.tsx';
import { Money } from '@/components/common/Money.tsx';
import { getMaterial } from '@/core/materials.ts';
import { CUT_GROUPS, fmtSheet, type GroupResult, type PosResult, type Settings } from '@/core/pricing.ts';
import { kg, m as meters, n0, n1, n2, NBSP, pct, rub, rub0, thick } from '@/format.ts';
import type { OrderPosition } from '@/order.ts';
import type { QuoteLine } from '@/quote.ts';

function Step({ cat, title, value, children }: { cat: CatKey; title: string; value: number; children: ReactNode }): ReactElement {
  return (
    <li className="space-y-1">
      <div className="flex items-baseline gap-2 font-medium">
        <CatDot cat={cat} className="self-center" />
        <span>{title}</span>
        <Money value={value} className="ml-auto" />
      </div>
      <div className="pl-4 text-[13px] leading-relaxed text-muted-foreground">{children}</div>
    </li>
  );
}

export interface PriceStepsProps {
  p: OrderPosition; // с предложениями ИИ (так и считалось)
  r: PosResult | undefined;
  g: GroupResult | undefined;
  line: QuoteLine | undefined;
  kop?: boolean; // КП «до копеек»
  settings: Settings;
  markupPct: number;
  unpriced: boolean;
}

export function PriceSteps({ p, r, g, line, kop, settings, markupPct, unpriced }: PriceStepsProps): ReactElement {
  return (
    <section aria-labelledby="steps-h" className="space-y-3">
      <h3 id="steps-h" className="text-sm font-semibold">
        Как получилась цена за 1 шт
      </h3>
      {p.disabled ? (
        <p className="text-sm text-muted-foreground">Позиция исключена из расчёта.</p>
      ) : unpriced ? (
        <p className="text-sm text-danger">Цена не посчитана: нет размеров. Задайте габарит вручную — форма «Габарит вручную» выше.</p>
      ) : !r || !g ? (
        <p className="text-sm text-muted-foreground">Расчёт обновляется…</p>
      ) : (
        <Steps p={p} r={r} g={g} line={line} kop={kop} settings={settings} markupPct={markupPct} />
      )}
    </section>
  );
}

function Steps({ p, r, g, line, kop, settings, markupPct }: Omit<PriceStepsProps, 'unpriced' | 'r' | 'g'> & { r: PosResult; g: GroupResult }): ReactElement {
  const mat = getMaterial(p.materialId);
  const setup = p.bends > 0 && settings.bendSetup > 0 ? settings.bendSetup / p.qty : 0;
  const o = g.chosen.offer;
  return (
    <ol className="space-y-3 text-sm">
      <Step cat="material" title="Металл" value={r.piece.material}>
        Группа «{mat.short} {thick(p.thickness)}»: лист {fmtSheet(o.w, o.l)} по {n2(o.pricePerKg)}
        {NBSP}₽/кг <span className="opacity-80">({o.note})</span> → {n1(g.chosen.sheetKg)}
        {NBSP}кг = {rub0(g.chosen.sheetPrice)} за лист.
        <br />
        {g.policy === 'bbox' ? (
          <>
            Списание по габариту деталей +{settings.bboxWastePct}
            {NBSP}%: {rub0(g.materialCost)} на группу.
          </>
        ) : g.chosen.capped ? (
          <>
            По раскрою вышло бы больше, но отход ограничен {settings.maxWastePct}
            {NBSP}% к габаритной массе (цех доложит деталь к другим заказам): {rub0(g.materialCost)} на группу.
          </>
        ) : (
          <>
            На всю группу {g.policy === 'whole' ? 'целыми листами' : 'по раскрою'}: {n2(g.chosen.sheetsCharged)} листа (заполнение {pct(g.chosen.nest.utilization)}) ={' '}
            {rub0(g.materialCost)}.
          </>
        )}
        <br />
        Доля детали — по габаритной площади: {n0(p.geom.width)}×{n0(p.geom.height)}
        {NBSP}мм × {p.qty}
        {NBSP}шт = {pct(r.share)} группы → {rub0(r.sum.material)} / {p.qty}
        {NBSP}шт = <span className="font-medium text-foreground">{rub(r.piece.material)}</span>.
        <br />
        <span className="opacity-80">
          Масса детали {kg(r.netKg)}, заготовки по габариту {kg(r.bboxKg)}; металл ≈ {n1(r.piece.material / Math.max(r.netKg, 0.001))}
          {NBSP}₽ за кг детали.
        </span>
      </Step>
      <Step cat="cut" title="Резка" value={r.piece.cut + r.piece.pierce}>
        {r.rate.perM != null ? (
          <>
            {n2(r.cutM)}
            {NBSP}м реза × {n1(r.rate.perM * r.rate.cutK)}
            {NBSP}₽/м = {rub(r.piece.cut)}; врезки {r.pierces} × {n1(r.rate.pierce * r.rate.cutK)}
            {NBSP}₽ = {rub(r.piece.pierce)}
            <span className="opacity-80">
              {' '}
              (прайс: {CUT_GROUPS.find((g) => g.key === r.rate.group)?.label.toLowerCase()}, строка {n1(r.rate.rowT ?? p.thickness)}
              {NBSP}мм{r.rate.rowT != null && Math.abs(r.rate.rowT - p.thickness) > 1e-9 ? `, толщина ${n1(p.thickness)} мм — по ближайшей большей` : ''}
              {r.rate.cutK !== 1 ? `; коэффициент материала ×${n2(r.rate.cutK)}` : ''})
            </span>
          </>
        ) : (
          <span className="text-warn">
            В прайсе резки нет цены для «{CUT_GROUPS.find((g) => g.key === r.rate.group)?.label.toLowerCase()}» {n1(p.thickness)}
            {NBSP}мм — резка не посчитана. Задайте цену в «Расценках» → «Резка».
          </span>
        )}
        {r.split && (
          <span className="mt-1 block text-warn">
            Деталь длиннее листа — считаем из {r.split.pieces} частей: +{meters(r.split.extraCut)} реза и +{r.split.pieces - 1} врезки на шт.
          </span>
        )}
      </Step>
      <Step cat="bend" title="Гибка" value={r.piece.bend}>
        {p.bends > 0 ? (
          <>
            {p.bends}
            {NBSP}гиб. × {n1(r.rate.perBend)}
            {NBSP}₽ × {n2(r.rate.lenK)} (длина гиба {n0(p.bendLength)}
            {NBSP}мм) = {rub(p.bends * r.rate.perBend * r.rate.lenK)}
            {setup > 0 && <> + наладка {rub(setup)}</>}
          </>
        ) : (
          <>Гибов нет. {p.detectedBends === 0 && 'В DXF линий гиба не найдено — если деталь гнутая, укажите число гибов в таблице.'}</>
        )}
      </Step>
      <Step cat="extras" title="Доп. работы" value={r.piece.extras}>
        {p.extras.length ? p.extras.map((e) => `${e.label || 'работа'} ${rub(e.perPiece)}`).join(' + ') : 'нет'}
      </Step>
      <li className="border-t pt-3 font-medium">
        {line?.price != null && line.sum != null ? (
          <>
            Себестоимость <Money value={r.piece.total} /> + наценка {n1(markupPct)}
            {NBSP}% = <Money value={line.price} kop={kop} /> за шт × {p.qty}
            {NBSP}шт = <Money value={line.sum} kop={kop} className="font-semibold" />
          </>
        ) : (
          <>
            Себестоимость <Money value={r.piece.total} /> за шт × {p.qty}
            {NBSP}шт = <Money value={r.sum.total} />
          </>
        )}
      </li>
    </ol>
  );
}
