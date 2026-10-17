// «Скопировать для клиента» + меню ▾ (таблицей для Excel, с вопросами клиенту, CSV) — шапка, полоса итогов, телефон.
// compact='auto': полная подпись от 1280 px, «Для клиента» от 1024 px, ниже — только значок.
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { ButtonGroup, ButtonGroupSeparator } from '@/components/ui/button-group.tsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { cn } from '@/lib/utils.ts';
import { ChevronDown, Copy, FileSpreadsheet } from '@/components/common/icons.ts';
import { MessageCircleQuestionMark, Table2 } from 'lucide-react';
import { copyForClient, downloadClientCsv } from '@/store/quoteActions.ts';
import { useStore } from '@/store/store.ts';

export interface CopyButtonProps {
  size?: 'sm' | 'default';
  variant?: 'default' | 'outline';
  withMenu?: boolean; // по умолчанию true
  compact?: 'auto' | 'icon' | 'short' | 'full';
  className?: string;
}

const LABEL = 'Скопировать для клиента';
const HINT = 'Текст для письма: позиции, цены за шт, суммы и итог — без себестоимости и наценки';

export function CopyButton({ size = 'default', variant = 'default', withMenu = true, compact = 'auto', className }: CopyButtonProps): ReactElement {
  const empty = useStore((s) => !s.order.positions.length);
  const questions = useStore((s) => s.order.ai?.analysis.questions.length ?? 0);
  const sm = size === 'sm';
  const iconOnly = compact === 'icon';

  const main = (
    <Button
      size={iconOnly ? (sm ? 'icon-sm' : 'icon') : size}
      variant={variant}
      disabled={empty}
      onClick={() => void copyForClient('text')}
      aria-label={LABEL}
      className={cn('min-w-0', compact === 'auto' && 'max-lg:px-2', withMenu ? 'flex-1 rounded-r-none' : className)}
    >
      <Copy data-icon={iconOnly ? undefined : 'inline-start'} />
      {compact === 'full' && <span className="truncate">{LABEL}</span>}
      {compact === 'short' && <span>Для клиента</span>}
      {compact === 'auto' && (
        <>
          <span className="hidden xl:inline">{LABEL}</span>
          <span className="hidden lg:inline xl:hidden">Для клиента</span>
        </>
      )}
    </Button>
  );

  const withTip = (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* у недоступной кнопки подсказка не всплывает — обёртка ловит наведение */}
        {empty ? (
          <span tabIndex={0} className={cn('inline-flex rounded-lg focus-ring', withMenu ? 'flex-1' : className)}>
            {main}
          </span>
        ) : (
          main
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom">{empty ? 'Нет позиций' : HINT}</TooltipContent>
    </Tooltip>
  );

  if (!withMenu) return withTip;

  return (
    <ButtonGroup className={className}>
      {withTip}
      {variant === 'default' && <ButtonGroupSeparator className="bg-primary-foreground/25" />}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size={sm ? 'icon-sm' : 'icon'} variant={variant} disabled={empty} aria-label="Другие способы отправки клиенту">
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-72">
          <DropdownMenuItem onSelect={() => void copyForClient('table')}>
            <Table2 />
            Скопировать таблицей (для Excel)
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!questions} onSelect={() => void copyForClient('questions')}>
            <MessageCircleQuestionMark />
            Скопировать с вопросами клиенту
            <span className="ml-auto pl-3 text-xs text-muted-foreground tabular-nums">{questions || 'нет'}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => downloadClientCsv()}>
            <FileSpreadsheet />
            Excel для клиента (CSV)
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}
