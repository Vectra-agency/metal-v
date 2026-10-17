// «Колонки»: какие столбцы таблицы позиций показывать (выбор сохраняется в браузере).
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { Columns3 } from '@/components/common/icons.ts';
import { setColumn } from '@/store/actions.ts';
import { useStore } from '@/store/store.ts';
import { COLUMN_LABEL } from './columns.ts';

export function ColumnsMenu(): ReactElement {
  const columns = useStore((s) => s.ui.columns);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Columns3 />
          Колонки
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Показывать в таблице</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {COLUMN_LABEL.map((c) => (
          <DropdownMenuCheckboxItem
            key={c.id}
            checked={columns[c.id]}
            onCheckedChange={(on) => setColumn(c.id, on === true)}
            onSelect={(e) => e.preventDefault()} // меню не закрывается: можно отметить несколько
          >
            {c.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
