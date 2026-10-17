// Строка над таблицей позиций: поиск («/»), фильтры с числами, «Колонки», «Деталь без чертежа».
// Поле поиска — id="positions-search" (на него ставит фокус клавиша «/»).
import type { ReactElement } from 'react';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group.tsx';
import { Kbd } from '@/components/ui/kbd.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { Plus, Search, X } from '@/components/common/icons.ts';
import { cn } from '@/lib/utils.ts';
import { openDialog, setFilter, setSearch } from '@/store/actions.ts';
import { useDerived } from '@/store/derived.tsx';
import { useStore } from '@/store/store.ts';
import type { TableFilter } from '@/store/types.ts';
import { ColumnsMenu } from './ColumnsMenu.tsx';
import { FILTERS, filterCounts, rowsFor } from './rowModel.ts';

export const SEARCH_ID = 'positions-search';

// выбранный фильтр — залит, как пресеты наценки (обычный bg-muted почти не виден, особенно в тёмной теме)
const TOGGLE_ON = 'data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary/90';

export function PositionsToolbar(): ReactElement {
  const d = useDerived();
  const order = useStore((s) => s.order);
  const addedIds = useStore((s) => s.pipeline.addedIds);
  const filter = useStore((s) => s.ui.filter);
  const search = useStore((s) => s.ui.search);
  const hasAi = !!order.ai;
  const counts = filterCounts(rowsFor(order, d, addedIds), hasAi);
  // «Не проверены ИИ» — только если анализ был и часть позиций он не видел
  const filters = FILTERS.filter((f) => f.id !== 'unchecked' || (hasAi && counts.unchecked > 0) || filter === 'unchecked');
  const onFilter = (v: string) => v && setFilter(v as TableFilter);
  return (
    <div className="flex w-full min-w-0 items-center gap-2">
      <InputGroup className="h-8 w-72 shrink max-xl:w-56 max-md:w-auto max-md:flex-1">
        <InputGroupAddon>
          <Search aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          id={SEARCH_ID}
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && search) {
              e.preventDefault();
              e.stopPropagation();
              setSearch('');
            }
          }}
          placeholder="Найти по обозначению или файлу"
          aria-label="Поиск позиций"
          autoComplete="off"
          className="[&::-webkit-search-cancel-button]:hidden"
        />
        <InputGroupAddon align="inline-end">
          {search ? (
            <InputGroupButton size="icon-xs" aria-label="Очистить поиск" onClick={() => setSearch('')}>
              <X />
            </InputGroupButton>
          ) : (
            <Kbd className="max-md:hidden">/</Kbd>
          )}
        </InputGroupAddon>
      </InputGroup>

      <ToggleGroup type="single" variant="outline" size="sm" value={filter} onValueChange={onFilter} aria-label="Фильтр позиций" className="max-xl:hidden">
        {filters.map((f) => (
          <ToggleGroupItem key={f.id} value={f.id} className={cn('gap-1.5 px-2.5 text-[13px]', TOGGLE_ON)}>
            {f.label}
            <Badge
              variant="secondary"
              className={cn(
                'h-4 min-w-4 px-1 text-[11px] tabular-nums',
                counts[f.id] === 0 && 'bg-transparent text-muted-foreground',
                'group-data-[state=on]/toggle:bg-primary-foreground/15 group-data-[state=on]/toggle:text-primary-foreground',
              )}
            >
              {counts[f.id]}
            </Badge>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {/* узкий экран: фильтры — списком */}
      <Select value={filter} onValueChange={onFilter}>
        <SelectTrigger size="sm" aria-label="Фильтр позиций" className="shrink-0 xl:hidden">
          <span className="text-muted-foreground max-sm:hidden">Показать:</span>
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          {filters.map((f) => (
            <SelectItem key={f.id} value={f.id}>
              {f.label} · {counts[f.id]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="flex-1 max-md:hidden" />
      <div className="max-md:hidden">
        <ColumnsMenu />
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => openDialog({ kind: 'manual' })}
        aria-label="Деталь без чертежа"
        title="Деталь без чертежа"
        className="shrink-0"
      >
        <Plus />
        {/* шесть фильтров (с «Не проверены ИИ») на 1280–1535 — без подписи, чтобы поиску осталось место */}
        <span className={filters.length > 5 ? 'max-2xl:hidden' : 'max-lg:hidden'}>Деталь без чертежа</span>
      </Button>
    </div>
  );
}
