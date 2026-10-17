// Позиции на телефоне (< 768 px): карточки только для чтения; нажатие открывает карточку позиции снизу.
import { useState, type ReactElement } from 'react';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { PartPreview } from '@/components/common/PartPreview.tsx';
import { Money } from '@/components/common/Money.tsx';
import { getMaterial } from '@/core/materials.ts';
import { n0, NBSP, thick } from '@/format.ts';
import { cn } from '@/lib/utils.ts';
import { openPosition, setFilter, setSearch } from '@/store/actions.ts';
import { useDerived } from '@/store/derived.tsx';
import { useStore } from '@/store/store.ts';
import { noGeomText } from './PositionRow.tsx';
import { rowsFor, visibleRows, type RowModel } from './rowModel.ts';
import { StatusCell } from './StatusCell.tsx';

const PAGE = 300;

function Card({ m, active, kop }: { m: RowModel; active: boolean; kop: boolean }): ReactElement {
  const p = m.pos;
  const off = !!p.disabled;
  const aiMarks = m.changes.length;
  return (
    <li>
      <button
        type="button"
        onClick={() => openPosition(m.base.id)}
        className={cn(
          'focus-ring flex w-full items-start gap-3 rounded-lg border bg-card p-3 text-left text-sm',
          active && 'border-primary/40 bg-accent',
          m.items.some((i) => i.severity === 'problem') && 'border-l-2 border-l-danger',
        )}
      >
        <PartPreview preview={p.preview} className={cn(off && 'opacity-60')} />
        <div className={cn('min-w-0 flex-1 space-y-0.5', off && 'opacity-60')}>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-medium">
              <span className="font-normal text-muted-foreground tabular-nums">{m.index}.</span> {p.name}
            </span>
            <StatusCell items={m.items} inScope={m.inScope} />
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>
              {getMaterial(p.materialId).short} {thick(p.thickness)} · {n0(p.qty)}
              {NBSP}шт
            </span>
            {aiMarks > 0 && <span className="rounded-sm bg-ai-soft px-1 text-[11px] font-medium text-ai">✦ ИИ</span>}
            {m.offers.length > 0 && (
              <span className="rounded-full border border-dashed border-ai px-1.5 text-[11px] text-ai">✦ предложений: {m.offers.length}</span>
            )}
            {off && (
              <Badge variant="outline" className="h-4 px-1.5 text-[11px]">
                исключена
              </Badge>
            )}
          </div>
          {m.unpriced ? (
            <div className="text-xs font-medium text-danger">{noGeomText(p)} — цена не посчитана</div>
          ) : (
            <div className="tabular-nums">
              <Money value={m.line?.price} kop={kop} className="font-medium" />
              <span className="text-muted-foreground">/шт · </span>
              <Money value={m.line?.sum} kop={kop} className="font-semibold" />
            </div>
          )}
        </div>
      </button>
    </li>
  );
}

export function PositionCards(): ReactElement {
  const d = useDerived();
  const kop = d.quote.settings.rounding === 'kop';
  const order = useStore((s) => s.order);
  const addedIds = useStore((s) => s.pipeline.addedIds);
  const filter = useStore((s) => s.ui.filter);
  const search = useStore((s) => s.ui.search);
  const sort = useStore((s) => s.ui.sort);
  const activeId = useStore((s) => (s.ui.sheet?.kind === 'position' ? s.ui.sheet.id : null));
  const [limit, setLimit] = useState(PAGE);
  const visible = visibleRows(rowsFor(order, d, addedIds), filter, search, sort, !!order.ai);
  const shown = visible.slice(0, limit);
  return (
    <div role="region" aria-label="Позиции" className="space-y-2">
      <ul className="space-y-2">
        {shown.map((m) => (
          <Card key={m.base.id} m={m} active={activeId === m.base.id} kop={kop} />
        ))}
      </ul>
      {!visible.length && (
        <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
          <p>{search ? `Ничего не найдено по запросу «${search}»` : 'В этом фильтре позиций нет'}</p>
          <Button
            variant="link"
            size="sm"
            onClick={() => {
              setFilter('all');
              setSearch('');
            }}
          >
            Показать все позиции
          </Button>
        </div>
      )}
      {visible.length > shown.length && (
        <Button variant="outline" className="w-full" onClick={() => setLimit((l) => l + PAGE)}>
          Показать ещё ({Math.min(PAGE, visible.length - shown.length)})
        </Button>
      )}
      <div className="flex justify-between rounded-lg border px-3 py-2 text-sm font-medium">
        <span>
          Итого {d.quote.lines.length}
          {NBSP}поз.
        </span>
        <span>
          <span className="mr-1 text-xs font-normal text-muted-foreground">клиенту</span>
          <Money value={d.quote.total} kop={kop} className="font-semibold" />
        </span>
      </div>
    </div>
  );
}
