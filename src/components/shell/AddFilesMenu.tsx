// «Добавить» в шапке (ui-spec §2.2): основная кнопка — выбор файлов, ▾ — файлы, папка, деталь без чертежа,
// заявка клиента (текст письма — в «Заявка и документы»). На телефоне — одна кнопка «+» с тем же меню.
import type { ReactElement } from 'react';
import { ClipboardList } from 'lucide-react';
import { cn } from '@/lib/utils.ts';
import { Button } from '@/components/ui/button.tsx';
import { ButtonGroup } from '@/components/ui/button-group.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { Kbd } from '@/components/ui/kbd.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { ChevronDown, FilePlus2, FolderUp, Pencil, Plus } from '@/components/common/icons.ts';
import { openDialog, openSheet } from '@/store/actions.ts';
import { openFilePicker, openFolderPicker } from './FilePickers.tsx';
import { MOD } from './useShortcuts.ts';

function Items(): ReactElement {
  return (
    <>
      <DropdownMenuItem onSelect={openFilePicker}>
        <FilePlus2 aria-hidden />
        Файлы DXF, PDF, TXT…
        <DropdownMenuShortcut>
          <Kbd>{MOD} O</Kbd>
        </DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={openFolderPicker}>
        <FolderUp aria-hidden />
        Папку…
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => openDialog({ kind: 'manual' })}>
        <Pencil aria-hidden />
        Деталь без чертежа…
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => openSheet({ kind: 'request', section: 'request' })}>
        <ClipboardList aria-hidden />
        Заявка клиента…
      </DropdownMenuItem>
    </>
  );
}

export function AddFilesMenu({ compact = false, className }: { compact?: boolean; className?: string }): ReactElement {
  if (compact) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" aria-label="Добавить" className={className}>
            <Plus />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-60">
          <Items />
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  return (
    <ButtonGroup aria-label="Добавить в заказ" className={cn('shrink-0', className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" onClick={openFilePicker} className="max-lg:px-2">
            <FilePlus2 data-icon="inline-start" />
            <span className="max-lg:sr-only">Добавить</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Файлы DXF, PDF, TXT · <Kbd>{MOD} O</Kbd>
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" aria-label="Другие способы добавить">
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-60">
          <Items />
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}
