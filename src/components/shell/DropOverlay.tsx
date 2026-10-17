// Перетаскивание файлов и папок в любое место окна (ui-spec §2.3). Пустой заказ или экран обработки — одна зона;
// непустой заказ — две половины: «Добавить к заказу» (слева) и «Новый заказ» (справа, с «Вернуть» 15 с).
import type { ReactElement } from 'react';
import { cn } from '@/lib/utils.ts';
import { FilePlus2, FileUp, FolderPlus } from '@/components/common/icons.ts';
import { useStore } from '@/store/store.ts';
import { useFileDrop, type DropHalf } from './useFileDrop.ts';

function Half({ side, active, icon, title, sub }: { side: DropHalf; active: boolean; icon: ReactElement; title: string; sub: string }): ReactElement {
  return (
    <div
      data-half={side}
      className={cn(
        'grid place-items-center rounded-2xl border-2 border-dashed p-6 text-center transition-colors',
        active ? 'border-primary bg-primary/5 ring-2 ring-primary' : 'border-border bg-background/60',
      )}
    >
      <div className="flex max-w-sm flex-col items-center gap-2">
        {icon}
        <div className="text-base font-medium text-balance">{title}</div>
        <div className="text-sm text-muted-foreground text-balance">{sub}</div>
      </div>
    </div>
  );
}

export function DropOverlay(): ReactElement | null {
  const { active, half } = useFileDrop();
  const hasPositions = useStore((s) => s.order.positions.length > 0);
  const processing = useStore((s) => s.pipeline.processing);
  const title = useStore((s) => s.order.title.trim());
  if (!active) return null;
  const split = hasPositions && !processing;
  return (
    <div className="pointer-events-none fixed inset-0 z-60 bg-background/80 p-6 backdrop-blur-sm" role="status" aria-live="polite">
      {split ? (
        <div className="grid h-full grid-cols-2 gap-6">
          <Half
            side="left"
            active={half === 'left'}
            icon={<FilePlus2 aria-hidden className="size-8" />}
            title={title ? `Добавить к заказу «${title}»` : 'Добавить к текущему заказу'}
            sub="Пересчитаем весь заказ, анализ ИИ — заново"
          />
          <Half
            side="right"
            active={half === 'right'}
            icon={<FolderPlus aria-hidden className="size-8" />}
            title="Новый заказ"
            sub="Текущий можно будет вернуть в течение 15 секунд"
          />
        </div>
      ) : (
        <div className="grid h-full place-items-center rounded-2xl border-2 border-dashed border-primary">
          <div className="flex flex-col items-center gap-2 text-base font-medium">
            <FileUp aria-hidden className="size-8" />
            {processing ? 'Отпустите — добавим к заказу' : 'Отпустите — начнём расчёт'}
          </div>
        </div>
      )}
    </div>
  );
}
