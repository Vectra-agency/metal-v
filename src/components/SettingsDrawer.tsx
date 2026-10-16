import { useState } from 'react';
import { MATERIALS, type SheetPolicy } from '../core/materials.ts';
import { DEFAULT_SETTINGS, type Settings } from '../core/pricing.ts';
import { NumInput } from './NumInput.tsx';

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
}

type Tab = 'cut' | 'bend' | 'mat' | 'nest';

export function SettingsDrawer({ settings: s, onChange, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('cut');
  const set = (patch: Partial<Settings>) => onChange({ ...s, ...patch });

  const exportJson = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' }));
    a.download = 'расценки.json';
    a.click();
  };
  const importJson = (f: File) =>
    f.text().then((t) => {
      try {
        onChange({ ...structuredClone(DEFAULT_SETTINGS), ...JSON.parse(t) });
      } catch {
        alert('Не удалось прочитать файл расценок');
      }
    });

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-label="Расценки" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-h">
          <h2>Расценки</h2>
          <button className="iconbtn" onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </header>
        <p className="muted small">
          Все цены — с НДС. Значения по умолчанию подобраны по реальным счетам (Лазерная резка СПб, МИЛП) — правьте под своего подрядчика. Изменения сохраняются в браузере.
        </p>
        <nav className="tabs" role="tablist">
          {(
            [
              ['cut', 'Резка'],
              ['bend', 'Гибка'],
              ['mat', 'Материалы'],
              ['nest', 'Раскрой и прочее'],
            ] as [Tab, string][]
          ).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
              {l}
            </button>
          ))}
        </nav>

        {tab === 'cut' && (
          <section>
            <p className="small muted">Чёрная сталь (Ст3). Для других материалов цена умножается на коэффициент со вкладки «Материалы». Между строками — линейная интерполяция.</p>
            <table className="edit-table">
              <thead>
                <tr>
                  <th>Толщина, мм</th>
                  <th>₽ за метр реза</th>
                  <th>₽ за врезку</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {s.cutting.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <NumInput value={r.t} width={60} onChange={(v) => set({ cutting: s.cutting.map((x, j) => (j === i ? { ...x, t: v } : x)) })} />
                    </td>
                    <td>
                      <NumInput value={r.perM} width={70} onChange={(v) => set({ cutting: s.cutting.map((x, j) => (j === i ? { ...x, perM: v } : x)) })} />
                    </td>
                    <td>
                      <NumInput value={r.pierce} width={60} onChange={(v) => set({ cutting: s.cutting.map((x, j) => (j === i ? { ...x, pierce: v } : x)) })} />
                    </td>
                    <td>
                      <button className="iconbtn" aria-label="Удалить строку" onClick={() => set({ cutting: s.cutting.filter((_, j) => j !== i) })}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn small" onClick={() => set({ cutting: [...s.cutting, { t: (s.cutting.at(-1)?.t ?? 0) + 1, perM: s.cutting.at(-1)?.perM ?? 50, pierce: s.cutting.at(-1)?.pierce ?? 10 }] })}>
              + строка
            </button>
          </section>
        )}

        {tab === 'bend' && (
          <section>
            <p className="small muted">Цена одного гиба длиной до 1 м. Для других длин — множитель из второй таблицы.</p>
            <table className="edit-table">
              <thead>
                <tr>
                  <th>Толщина, мм</th>
                  <th>₽ за гиб</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {s.bending.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <NumInput value={r.t} width={60} onChange={(v) => set({ bending: s.bending.map((x, j) => (j === i ? { ...x, t: v } : x)) })} />
                    </td>
                    <td>
                      <NumInput value={r.perBend} width={70} onChange={(v) => set({ bending: s.bending.map((x, j) => (j === i ? { ...x, perBend: v } : x)) })} />
                    </td>
                    <td>
                      <button className="iconbtn" aria-label="Удалить строку" onClick={() => set({ bending: s.bending.filter((_, j) => j !== i) })}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn small" onClick={() => set({ bending: [...s.bending, { t: (s.bending.at(-1)?.t ?? 0) + 2, perBend: s.bending.at(-1)?.perBend ?? 100 }] })}>
              + строка
            </button>
            <h3>Множитель по длине гиба</h3>
            <table className="edit-table">
              <thead>
                <tr>
                  <th>Длина до, мм</th>
                  <th>Множитель</th>
                </tr>
              </thead>
              <tbody>
                {s.bendLenK.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <NumInput value={r.upTo} width={70} onChange={(v) => set({ bendLenK: s.bendLenK.map((x, j) => (j === i ? { ...x, upTo: v } : x)) })} />
                    </td>
                    <td>
                      <NumInput value={r.k} width={60} onChange={(v) => set({ bendLenK: s.bendLenK.map((x, j) => (j === i ? { ...x, k: v } : x)) })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <label className="field">
              <span>Наладка листогиба на позицию</span>
              <NumInput value={s.bendSetup} suffix="₽" width={70} onChange={(v) => set({ bendSetup: v })} />
            </label>
            <p className="small muted">Наладка делится на количество деталей в позиции — заметна на малых партиях.</p>
          </section>
        )}

        {tab === 'mat' && (
          <section>
            <table className="edit-table">
              <thead>
                <tr>
                  <th>Материал</th>
                  <th title="Множитель к расценке резки">k резки</th>
                  <th title="Множитель к цене гиба">k гибки</th>
                  <th>Списание металла</th>
                </tr>
              </thead>
              <tbody>
                {MATERIALS.map((mt) => (
                  <tr key={mt.id}>
                    <td>
                      {mt.label}
                      <div className="small muted">{mt.density} кг/м³</div>
                    </td>
                    <td>
                      <NumInput
                        value={s.matK[mt.id]?.cutK ?? mt.cutK}
                        width={50}
                        onChange={(v) => set({ matK: { ...s.matK, [mt.id]: { ...s.matK[mt.id], cutK: v } } })}
                      />
                    </td>
                    <td>
                      <NumInput
                        value={s.matK[mt.id]?.bendK ?? mt.bendK}
                        width={50}
                        onChange={(v) => set({ matK: { ...s.matK, [mt.id]: { ...s.matK[mt.id], bendK: v } } })}
                      />
                    </td>
                    <td>
                      <select value={s.policy[mt.id] ?? mt.policy} onChange={(e) => set({ policy: { ...s.policy, [mt.id]: e.target.value as SheetPolicy } })}>
                        <option value="length">по раскрою</option>
                        <option value="whole">целыми листами</option>
                        <option value="bbox">по габариту + отход</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="small muted">
              <li>
                <b>По раскрою</b> — полные листы плюс занятая часть последнего (остаток остаётся у цеха).
              </li>
              <li>
                <b>Целыми листами</b> — каждый начатый лист оплачивается полностью (нержавейка, алюминий).
              </li>
              <li>
                <b>По габариту</b> — масса габаритных заготовок плюс процент отхода, без раскладки.
              </li>
            </ul>
          </section>
        )}

        {tab === 'nest' && (
          <section className="fields">
            <label className="field">
              <span>Перемычка между деталями</span>
              <NumInput value={s.gap} suffix="мм" width={60} onChange={(v) => set({ gap: v })} />
            </label>
            <label className="field">
              <span>Поле по краю листа</span>
              <NumInput value={s.margin} suffix="мм" width={60} onChange={(v) => set({ margin: v })} />
            </label>
            <label className="field">
              <span>Потолок отхода при раскрое</span>
              <NumInput value={s.maxWastePct} suffix="%" width={60} onChange={(v) => set({ maxWastePct: v })} />
            </label>
            <p className="small muted">Металл по раскрою не дороже, чем габаритная масса заготовок плюс этот процент: неудобные детали цех докладывает к чужим заказам.</p>
            <label className="field">
              <span>Потолок отхода «целыми листами»</span>
              <NumInput value={s.maxWasteWholePct ?? 100} suffix="%" width={60} onChange={(v) => set({ maxWasteWholePct: v })} />
            </label>
            <p className="small muted">Чтобы одна мелкая деталь из нержавейки или алюминия не оплачивала весь лист.</p>
            <label className="field">
              <span>Отход при списании «по габариту»</span>
              <NumInput value={s.bboxWastePct} suffix="%" width={60} onChange={(v) => set({ bboxWastePct: v })} />
            </label>
            <label className="field">
              <span>Ставка НДС (цены уже с НДС)</span>
              <NumInput value={s.vatPct} suffix="%" width={60} onChange={(v) => set({ vatPct: v })} />
            </label>
          </section>
        )}

        <footer className="drawer-f">
          <button
            className="btn"
            onClick={() => {
              if (confirm('Вернуть все расценки к значениям по умолчанию?')) onChange(structuredClone(DEFAULT_SETTINGS));
            }}
          >
            Сбросить
          </button>
          <button className="btn" onClick={exportJson}>
            Сохранить в файл
          </button>
          <label className="btn">
            Загрузить из файла
            <input type="file" accept=".json" hidden onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])} />
          </label>
        </footer>
      </aside>
    </div>
  );
}
