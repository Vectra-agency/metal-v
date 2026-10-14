import { Fragment, useMemo, useState } from 'react';
import { MATERIALS, getMaterial } from '../core/materials.ts';
import { fmtSheet, type OrderResult, type PosResult, type Position, type Settings } from '../core/pricing.ts';
import { kg, m, n0, n1, n2, pct, rub, rub0, thick } from '../format.ts';
import type { OrderPosition } from '../order.ts';
import { CostBar } from './CostBar.tsx';
import { NumInput } from './NumInput.tsx';
import { PartPreview } from './PartPreview.tsx';

interface Props {
  positions: OrderPosition[];
  res: OrderResult;
  settings: Settings;
  onUpdate: (id: string, patch: Partial<OrderPosition>) => void;
  onBulk: (ids: string[], patch: Partial<OrderPosition>) => void;
  onRemove: (ids: string[]) => void;
  onDuplicate: (id: string) => void;
  highlight: string | null;
  onHighlight: (id: string | null) => void;
}

type SortKey = 'none' | 'name' | 'piece' | 'sum';

const EXTRA_PRESETS = ['Вальцовка', 'Сварка', 'Зачистка кромок', 'Покраска', 'Зенковка', 'Нарезка резьбы', 'Упаковка'];

function ThicknessSelect({ materialId, value, onChange, guessed }: { materialId: string; value: number; onChange: (t: number) => void; guessed?: boolean }) {
  const mat = getMaterial(materialId);
  const opts = [...new Set([...mat.thicknesses, value])].sort((a, b) => a - b);
  return (
    <select
      className={`sel-t ${guessed ? 'guessed' : ''}`}
      value={String(value)}
      title={guessed ? 'Толщина не распознана в имени файла — проверьте' : 'Толщина'}
      onChange={(e) => {
        if (e.target.value === 'other') {
          const v = Number((prompt('Толщина, мм', String(value)) ?? '').replace(',', '.'));
          if (v > 0 && v < 200) onChange(v);
          return;
        }
        onChange(Number(e.target.value));
      }}
    >
      {opts.map((t) => (
        <option key={t} value={String(t)}>
          {n1(t)} мм
        </option>
      ))}
      <option value="other">другая…</option>
    </select>
  );
}

function MaterialSelect({ value, onChange, guessed, placeholder }: { value: string; onChange: (id: string) => void; guessed?: boolean; placeholder?: boolean }) {
  return (
    <select
      className={`sel-m ${guessed ? 'guessed' : ''}`}
      value={value}
      title={guessed ? 'Материал не распознан в имени файла — проверьте' : 'Материал'}
      onChange={(e) => e.target.value && onChange(e.target.value)}
    >
      {placeholder && <option value="">—</option>}
      {MATERIALS.map((mm) => (
        <option key={mm.id} value={mm.id}>
          {mm.short}
        </option>
      ))}
    </select>
  );
}

export function PositionsTable(props: Props) {
  const { positions, res, onUpdate, onBulk, onRemove } = props;
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'none', dir: 1 });

  const rows = useMemo(() => {
    const list = positions.slice();
    if (sort.key === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'ru') * sort.dir);
    if (sort.key === 'piece' || sort.key === 'sum') {
      const v = (p: OrderPosition) => {
        const r = res.positions.get(p.id);
        return r ? (sort.key === 'piece' ? r.piece.total : r.sum.total) : -1;
      };
      list.sort((a, b) => (v(a) - v(b)) * sort.dir);
    }
    return list;
  }, [positions, res, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? (s.dir === -1 ? { key: 'none', dir: 1 } : { key, dir: -1 }) : { key, dir: key === 'name' ? 1 : -1 }));
  const sortMark = (key: SortKey) => (sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : '');

  const toggleOpen = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allSelected = sel.size > 0 && sel.size === positions.length;
  const ids = [...sel].filter((id) => positions.some((p) => p.id === id));

  return (
    <div className="table-wrap">
      {ids.length > 0 && (
        <div className="bulkbar" role="toolbar" aria-label="Действия с выбранными">
          <b>Выбрано: {ids.length}</b>
          <label>
            материал
            <MaterialSelect value="" placeholder onChange={(id) => onBulk(ids, { materialId: id })} />
          </label>
          <label>
            толщина
            <select value="" onChange={(e) => e.target.value && onBulk(ids, { thickness: Number(e.target.value) })}>
              <option value="">—</option>
              {[0.5, 0.7, 0.8, 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 14, 16, 20, 25].map((t) => (
                <option key={t} value={t}>
                  {n1(t)} мм
                </option>
              ))}
            </select>
          </label>
          <label>
            гибов
            <NumInput value={0} allowEmpty placeholder="—" width={44} onChange={(v) => onBulk(ids, { bends: Math.round(v) })} />
          </label>
          <label>
            кол-во
            <NumInput value={0} allowEmpty placeholder="—" width={52} onChange={(v) => v >= 1 && onBulk(ids, { qty: Math.round(v) })} />
          </label>
          <button className="btn small" onClick={() => onBulk(ids, { disabled: false })}>
            Включить в расчёт
          </button>
          <button className="btn small" onClick={() => onBulk(ids, { disabled: true })}>
            Исключить
          </button>
          <button
            className="btn small danger"
            onClick={() => {
              if (confirm(`Удалить ${ids.length} поз.?`)) {
                onRemove(ids);
                setSel(new Set());
              }
            }}
          >
            Удалить
          </button>
          <button className="btn small ghost" onClick={() => setSel(new Set())}>
            Снять выделение
          </button>
        </div>
      )}
      <table className="ptable">
        <thead>
          <tr>
            <th className="c-sel">
              <input
                type="checkbox"
                aria-label="Выбрать все"
                checked={allSelected}
                onChange={() => setSel(allSelected ? new Set() : new Set(positions.map((p) => p.id)))}
              />
            </th>
            <th className="c-thumb" />
            <th className="c-name sortable" onClick={() => toggleSort('name')}>
              Деталь{sortMark('name')}
            </th>
            <th className="c-mat">Материал</th>
            <th className="c-qty r">Кол-во</th>
            <th className="c-geo">Габарит · масса · рез</th>
            <th className="c-bends">Гибы</th>
            <th className="c-money r" title="Металл на 1 шт">
              <span className="dot" style={{ background: 'var(--c-metal)' }} />
              Металл
            </th>
            <th className="c-money r" title="Резка на 1 шт (метры + врезки)">
              <span className="dot" style={{ background: 'var(--c-cut)' }} />
              Резка
            </th>
            <th className="c-money r" title="Гибка на 1 шт">
              <span className="dot" style={{ background: 'var(--c-bend)' }} />
              Гибка
            </th>
            <th className="c-money r" title="Доп. работы на 1 шт">
              <span className="dot" style={{ background: 'var(--c-extra)' }} />
              Доп.
            </th>
            <th className="c-price r sortable" onClick={() => toggleSort('piece')}>
              Цена за шт{sortMark('piece')}
            </th>
            <th className="c-sum r sortable" onClick={() => toggleSort('sum')}>
              Сумма{sortMark('sum')}
            </th>
            <th className="c-act" />
          </tr>
        </thead>
        <tbody>
          {rows.map((p, idx) => {
            const r = res.positions.get(p.id);
            const isOpen = open.has(p.id);
            const warn = [...p.warnings, ...(r?.warnings ?? [])];
            return (
              <Fragment key={p.id}>
                <tr
                  className={`prow ${p.disabled ? 'disabled' : ''} ${isOpen ? 'open' : ''} ${props.highlight === p.id ? 'hl' : ''}`}
                  onMouseEnter={() => props.onHighlight(p.id)}
                  onMouseLeave={() => props.onHighlight(null)}
                >
                  <td className="c-sel">
                    <input
                      type="checkbox"
                      aria-label={`Выбрать ${p.name}`}
                      checked={sel.has(p.id)}
                      onChange={() =>
                        setSel((s) => {
                          const n = new Set(s);
                          if (n.has(p.id)) n.delete(p.id);
                          else n.add(p.id);
                          return n;
                        })
                      }
                    />
                  </td>
                  <td className="c-thumb" onClick={() => toggleOpen(p.id)} title="Подробный расчёт">
                    <PartPreview preview={p.preview} />
                  </td>
                  <td className="c-name">
                    <button className="linklike pname" onClick={() => toggleOpen(p.id)} title="Подробный расчёт">
                      <span className="idx">{idx + 1}.</span> {p.name}
                    </button>
                    {p.fileName && p.fileName !== p.name && <div className="pfile">{p.fileName}</div>}
                    {warn.length > 0 && (
                      <div className="pwarn" title={warn.join('\n')}>
                        ⚠ {warn[0]}
                        {warn.length > 1 ? ` (+${warn.length - 1})` : ''}
                      </div>
                    )}
                    {p.disabled && <div className="pwarn muted">исключена из расчёта</div>}
                  </td>
                  <td className="c-mat">
                    <MaterialSelect value={p.materialId} guessed={p.guessed.material} onChange={(id) => onUpdate(p.id, { materialId: id, guessed: { ...p.guessed, material: false } })} />
                    <ThicknessSelect
                      materialId={p.materialId}
                      value={p.thickness}
                      guessed={p.guessed.thickness}
                      onChange={(t) => onUpdate(p.id, { thickness: t, guessed: { ...p.guessed, thickness: false } })}
                    />
                  </td>
                  <td className="c-qty r">
                    <NumInput
                      className={p.guessed.qty ? 'guessed' : ''}
                      title={p.guessed.qty ? 'Количество не найдено в имени файла — проверьте' : 'Количество, шт'}
                      value={p.qty}
                      min={1}
                      width={52}
                      onChange={(v) => onUpdate(p.id, { qty: Math.max(1, Math.round(v)), guessed: { ...p.guessed, qty: false } })}
                    />
                  </td>
                  <td className="c-geo">
                    <div>
                      {n0(p.geom.width)} × {n0(p.geom.height)} мм
                    </div>
                    <div className="muted small">
                      {r ? kg(r.netKg) : '—'} · {r ? m(r.cutM * 1000) : m(p.geom.cutLength)} · {r?.pierces ?? p.geom.pierces} вр.
                    </div>
                  </td>
                  <td className="c-bends">
                    <div className="bends-edit">
                      <NumInput
                        value={p.bends}
                        width={36}
                        title={p.detectedBends ? `Найдено линий гиба в DXF: ${p.detectedBends}` : 'Количество гибов на 1 шт (в DXF линий гиба нет)'}
                        onChange={(v) => onUpdate(p.id, { bends: Math.round(v) })}
                      />
                      <span className="muted small">×</span>
                      <NumInput value={p.bendLength} width={54} title="Длина гиба, мм" onChange={(v) => onUpdate(p.id, { bendLength: v })} suffix="мм" />
                    </div>
                  </td>
                  <td className="c-money r">{r ? rub(r.piece.material) : '—'}</td>
                  <td className="c-money r">{r ? rub(r.piece.cut + r.piece.pierce) : '—'}</td>
                  <td className="c-money r">{r && r.piece.bend ? rub(r.piece.bend) : <span className="muted">—</span>}</td>
                  <td className="c-money r">{r && r.piece.extras ? rub(r.piece.extras) : <span className="muted">—</span>}</td>
                  <td className="c-price r">
                    <div className="strong">{r ? rub(r.piece.total) : '—'}</div>
                    {r && <CostBar parts={{ material: r.piece.material, cut: r.piece.cut + r.piece.pierce, bend: r.piece.bend, extras: r.piece.extras }} height={4} />}
                  </td>
                  <td className="c-sum r strong">{r ? rub0(r.sum.total) : '—'}</td>
                  <td className="c-act">
                    <button className={`iconbtn chev ${isOpen ? 'up' : ''}`} onClick={() => toggleOpen(p.id)} aria-label="Подробнее" title="Подробный расчёт">
                      ▾
                    </button>
                  </td>
                </tr>
                {isOpen && (
                  <tr className="pdetail">
                    <td colSpan={14}>
                      <Detail {...props} p={p} r={r} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Detail({ p, r, res, settings, onUpdate, onRemove, onDuplicate }: Props & { p: OrderPosition; r?: PosResult }) {
  const mat = getMaterial(p.materialId);
  const setup = p.bends > 0 && settings.bendSetup > 0 ? settings.bendSetup / p.qty : 0;
  const g = r ? res.groups.find((x) => x.key === r.groupKey) : undefined;
  const setExtras = (extras: Position['extras']) => onUpdate(p.id, { extras });
  return (
    <div className="detail">
      <div className="d-preview">
        <PartPreview preview={p.preview} size="large" showIgnored dims={{ w: p.geom.width, h: p.geom.height }} />
        <div className="pv-legend small muted">
          <span>
            <i className="lg lg-part" /> контур детали
          </span>
          <span>
            <i className="lg lg-bend" /> линия гиба
          </span>
          <span>
            <i className="lg lg-ign" /> не в расчёте (рамка, обрывки)
          </span>
        </div>
        <dl className="facts small">
          <dt>Площадь детали</dt>
          <dd>{n2(p.geom.netArea / 1e6)} м²</dd>
          <dt>Габаритная площадь</dt>
          <dd>{n2(p.geom.bboxArea / 1e6)} м²</dd>
          <dt>Длина реза</dt>
          <dd>{m(p.geom.cutLength)}</dd>
          <dt>Врезок (контуров)</dt>
          <dd>{p.geom.pierces}</dd>
          {p.geom.count > 1 && (
            <>
              <dt>Деталей в файле</dt>
              <dd>{p.geom.count}</dd>
            </>
          )}
        </dl>
      </div>

      <div className="d-calc">
        <h4>Как считается цена за 1 шт</h4>
        {!r || !g ? (
          <p className="muted">Позиция исключена из расчёта.</p>
        ) : (
          <ol className="steps">
            <li>
              <div className="step-h">
                <span className="dot" style={{ background: 'var(--c-metal)' }} />
                Металл <b>{rub(r.piece.material)}</b>
              </div>
              <div className="step-b">
                Группа «{mat.short} {thick(p.thickness)}»: лист {fmtSheet(g.chosen.offer.w, g.chosen.offer.l)} по {n2(g.chosen.offer.pricePerKg)} ₽/кг
                <span className="muted"> ({g.chosen.offer.note})</span> → {n1(g.chosen.sheetKg)} кг = {rub0(g.chosen.sheetPrice)} за лист.
                <br />
                {g.policy === 'bbox' ? (
                  <>
                    Списание по габариту деталей +{settings.bboxWastePct}%: {rub0(g.materialCost)} на группу.
                  </>
                ) : g.chosen.capped ? (
                  <>
                    По раскрою вышло бы больше, но отход ограничен {settings.maxWastePct}% к габаритной массе (цех доложит деталь к другим заказам): {rub0(g.materialCost)} на группу.
                  </>
                ) : (
                  <>
                    На всю группу {g.policy === 'whole' ? 'целыми листами' : 'по раскрою'}: {n2(g.chosen.sheetsCharged)} листа (заполнение {pct(g.chosen.nest.utilization)}) = {rub0(g.materialCost)}.
                  </>
                )}
                <br />
                Доля детали — по габаритной площади: {n0(p.geom.width)}×{n0(p.geom.height)} мм × {p.qty} шт = {pct(r.share)} группы → {rub0(r.sum.material)} / {p.qty} шт ={' '}
                <b>{rub(r.piece.material)}</b>.
                <br />
                <span className="muted">
                  Масса детали {kg(r.netKg)}, заготовки по габариту {kg(r.bboxKg)}; металл ≈ {n1(r.piece.material / Math.max(r.netKg, 0.001))} ₽ за кг детали.
                </span>
              </div>
            </li>
            <li>
              <div className="step-h">
                <span className="dot" style={{ background: 'var(--c-cut)' }} />
                Резка <b>{rub(r.piece.cut + r.piece.pierce)}</b>
              </div>
              <div className="step-b">
                {n2(r.cutM)} м × {n1(r.rate.perM)} ₽/м = {rub(r.piece.cut)}; врезки {r.pierces} × {n1(r.rate.pierce)} ₽ = {rub(r.piece.pierce)}
                {r.rate.cutK !== 1 && <span className="muted"> (коэфф. материала {n2(r.rate.cutK)} уже учтён)</span>}
                {r.split && (
                  <div className="warn-inline">
                    Деталь длиннее листа — считаем из {r.split.pieces} частей: +{m(r.split.extraCut)} реза и +{r.split.pieces - 1} врезки на шт.
                  </div>
                )}
              </div>
            </li>
            <li>
              <div className="step-h">
                <span className="dot" style={{ background: 'var(--c-bend)' }} />
                Гибка <b>{rub(r.piece.bend)}</b>
              </div>
              <div className="step-b">
                {p.bends > 0 ? (
                  <>
                    {p.bends} гиб. × {n1(r.rate.perBend)} ₽ × {n2(r.rate.lenK)} (длина гиба {n0(p.bendLength)} мм) = {rub(p.bends * r.rate.perBend * r.rate.lenK)}
                    {setup > 0 && <> + наладка {rub(setup)}</>}
                  </>
                ) : (
                  <span className="muted">
                    Гибов нет. {p.detectedBends === 0 && 'В DXF линий гиба не найдено — если деталь гнутая, укажите число гибов в таблице.'}
                  </span>
                )}
              </div>
            </li>
            <li>
              <div className="step-h">
                <span className="dot" style={{ background: 'var(--c-extra)' }} />
                Доп. работы <b>{rub(r.piece.extras)}</b>
              </div>
              <div className="step-b">
                {p.extras.length ? p.extras.map((e) => `${e.label || 'работа'} ${rub(e.perPiece)}`).join(' + ') : <span className="muted">нет</span>}
              </div>
            </li>
            <li className="step-total">
              Итого: <b>{rub(r.piece.total)}</b> за шт × {p.qty} шт = <b>{rub0(r.sum.total)}</b>
            </li>
          </ol>
        )}
      </div>

      <div className="d-extras">
        <h4>Доп. работы на 1 шт</h4>
        {p.extras.map((e, i) => (
          <div className="extra-row" key={i}>
            <input
              value={e.label}
              placeholder="Название"
              onChange={(ev) => setExtras(p.extras.map((x, j) => (j === i ? { ...x, label: ev.target.value } : x)))}
            />
            <NumInput value={e.perPiece} suffix="₽" width={70} onChange={(v) => setExtras(p.extras.map((x, j) => (j === i ? { ...x, perPiece: v } : x)))} />
            <button className="iconbtn" aria-label="Удалить работу" onClick={() => setExtras(p.extras.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        ))}
        <div className="chips">
          {EXTRA_PRESETS.map((label) => (
            <button key={label} className="chip" onClick={() => setExtras([...p.extras, { label, perPiece: 0 }])}>
              + {label}
            </button>
          ))}
        </div>
        <h4>Примечание</h4>
        <textarea rows={2} value={p.note ?? ''} placeholder="Например: из двух частей, без вальцовки" onChange={(e) => onUpdate(p.id, { note: e.target.value })} />
        {p.warnings.length > 0 && (
          <ul className="warnlist small">
            {p.warnings.map((w, i) => (
              <li key={i}>⚠ {w}</li>
            ))}
          </ul>
        )}
        <div className="row-actions">
          <button className="btn small" onClick={() => onDuplicate(p.id)}>
            Дублировать
          </button>
          <button className="btn small" onClick={() => onUpdate(p.id, { disabled: !p.disabled })}>
            {p.disabled ? 'Включить в расчёт' : 'Исключить из расчёта'}
          </button>
          <button className="btn small danger" onClick={() => onRemove([p.id])}>
            Удалить
          </button>
        </div>
      </div>
    </div>
  );
}
