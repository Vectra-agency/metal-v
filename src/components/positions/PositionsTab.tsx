// Вкладка «Позиции»: таблица с правкой, выбором и массовой правкой; на телефоне — карточки (только просмотр).
import type { ReactElement } from 'react';
import { useMediaQuery } from '@/hooks/useMediaQuery.ts';
import { cn } from '@/lib/utils.ts';
import { useStore } from '@/store/store.ts';
import { BulkBar } from './BulkBar.tsx';
import { PositionCards } from './PositionCards.tsx';
import { PositionsTable } from './PositionsTable.tsx';

export function PositionsTab(): ReactElement {
  const phone = useMediaQuery('(max-width: 767px)');
  const bulk = useStore((s) => s.ui.selection.length > 0);
  if (phone) return <PositionCards />;
  return (
    // строки выбраны — снизу панель массовой правки (уже 1280 px — в две строки): место под ней, чтобы не закрывала итог
    <div className={cn(bulk && 'max-xl:pb-8')}>
      <PositionsTable />
      <BulkBar />
    </div>
  );
}
