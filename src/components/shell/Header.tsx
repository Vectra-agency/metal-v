// Шапка (ui-spec §2.2): марка, название заказа, этапы, «Добавить», «Скопировать для клиента», печать КП, «Расценки», «Ещё».
// Узкий экран (< 768 px): без марки, название на всю ширину, «+» и «Ещё» (в нём же копирование, печать, расценки);
// этапы — второй строкой. Высота шапки → --header-h (по ней липнет полоса вкладок).
import { useEffect, useRef, type ReactElement } from 'react';
import { Button } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Kbd } from '@/components/ui/kbd.tsx';
import { useTheme, type Theme } from '@/components/ui/theme.ts';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { Copy, Ellipsis, FilePlus2, FileSpreadsheet, Printer, SlidersHorizontal } from '@/components/common/icons.ts';
import { CopyButton } from '@/components/quote/CopyButton.tsx';
import { useMediaQuery } from '@/hooks/useMediaQuery.ts';
import type { Order } from '@/order.ts';
import { openDialog, openSheet, setTitle } from '@/store/actions.ts';
import { startNewOrder } from '@/store/pipelineActions.ts';
import { copyForClient, downloadInternalCsv, printClient, printInternal } from '@/store/quoteActions.ts';
import { useStore } from '@/store/store.ts';
import { FileText, Keyboard, SunMoon } from 'lucide-react';
import { AddFilesMenu } from './AddFilesMenu.tsx';
import { FilePickers } from './FilePickers.tsx';
import { StagePills } from './StagePills.tsx';
import { MOD } from './useShortcuts.ts';

function Brand(): ReactElement {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden className="fill-metal">
        <rect x="3" y="8" width="26" height="16" rx="2" />
        <path d="M8 8v16M24 8v16" className="stroke-background" strokeWidth="2" strokeDasharray="3 2" />
      </svg>
      <span className="hidden text-sm font-semibold whitespace-nowrap 2xl:inline">Расчёт деталей</span>
    </div>
  );
}

/** Кнопка с подсказкой; недоступная — подсказка «Нет позиций» (на обёртке: у disabled нет событий мыши) */
function Hinted({ hint, disabled, children }: { hint: ReactElement | string; disabled?: boolean; children: ReactElement }): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{disabled ? <span className="inline-flex" tabIndex={0}>{children}</span> : children}</TooltipTrigger>
      <TooltipContent>{disabled ? 'Нет позиций' : hint}</TooltipContent>
    </Tooltip>
  );
}

const THEMES: { id: Theme; label: string }[] = [
  { id: 'light', label: 'Светлая' },
  { id: 'dark', label: 'Тёмная' },
  { id: 'system', label: 'Как в системе' },
];

/** В заказе ничего нет: ни позиций, ни документов, ни заявки, ни названия — «Новый заказ» не нужен */
const blankOrder = (o: Order): boolean => !o.positions.length && !(o.documents ?? []).length && !(o.request ?? '').trim() && !o.title.trim();

function MoreMenu({ compact }: { compact: boolean }): ReactElement {
  const empty = useStore((s) => !s.order.positions.length);
  const blank = useStore((s) => blankOrder(s.order));
  const { theme, setTheme } = useTheme();
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Ещё">
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Ещё</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-auto min-w-64">
        {compact && (
          <>
            <DropdownMenuItem disabled={empty} onSelect={() => void copyForClient()}>
              <Copy aria-hidden />
              Скопировать для клиента
            </DropdownMenuItem>
            <DropdownMenuItem disabled={empty} onSelect={() => printClient()}>
              <Printer aria-hidden />
              Печать КП
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openSheet({ kind: 'settings' })}>
              <SlidersHorizontal aria-hidden />
              Расценки
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem disabled={empty} onSelect={() => printInternal()}>
          <Printer aria-hidden />
          Печать расчёта (внутр.)
          {empty && <DropdownMenuShortcut className="tracking-normal">нет позиций</DropdownMenuShortcut>}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={empty} onSelect={() => downloadInternalCsv()}>
          <FileSpreadsheet aria-hidden />
          Excel: внутренний расчёт
          {empty && <DropdownMenuShortcut className="tracking-normal">нет позиций</DropdownMenuShortcut>}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openSheet({ kind: 'request' })}>
          <FileText aria-hidden />
          Заявка и документы
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openDialog({ kind: 'shortcuts' })}>
          <Keyboard aria-hidden />
          Горячие клавиши
          <DropdownMenuShortcut>
            <Kbd>?</Kbd>
          </DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <SunMoon aria-hidden />
            Тема
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
              {THEMES.map((t) => (
                <DropdownMenuRadioItem key={t.id} value={t.id}>
                  {t.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={blank} onSelect={startNewOrder}>
          <FilePlus2 aria-hidden />
          Новый заказ
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Header(): ReactElement {
  const title = useStore((s) => s.order.title);
  const empty = useStore((s) => !s.order.positions.length);
  const pills = useStore((s) => s.pipeline.processing || s.order.positions.length > 0);
  const compact = !useMediaQuery('(min-width: 768px)');
  const ref = useRef<HTMLElement>(null);

  // высота шапки (на телефоне — две строки) → --header-h для липкой полосы вкладок
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement;
    const ro = new ResizeObserver(() => root.style.setProperty('--header-h', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--header-h');
    };
  }, []);

  return (
    <header ref={ref} className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur">
      <div className="flex h-14 items-center gap-2 px-4 lg:gap-3 lg:px-6">
        {!compact && <Brand />}
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Название заказа или клиента"
          aria-label="Название заказа или клиента"
          className="h-8 min-w-0 flex-1 md:w-72 md:min-w-24 md:flex-none md:shrink xl:w-96"
        />
        {!compact && <StagePills />}
        {compact ? (
          <AddFilesMenu compact />
        ) : (
          <>
            <AddFilesMenu className="ml-auto" />
            <CopyButton compact="auto" className="shrink-0" />
            <Hinted
              disabled={empty}
              hint={
                <>
                  Печать КП <Kbd>{MOD} P</Kbd>
                </>
              }
            >
              <Button variant="ghost" size="icon" aria-label={`Печать КП (${MOD}+P)`} disabled={empty} onClick={() => printClient()}>
                <Printer />
              </Button>
            </Hinted>
            <Hinted hint="Расценки: резка, гибка, материалы, КП">
              <Button variant="ghost" aria-label="Расценки" className="shrink-0 max-xl:px-2" onClick={() => openSheet({ kind: 'settings' })}>
                <SlidersHorizontal data-icon="inline-start" />
                <span className="max-xl:sr-only">Расценки</span>
              </Button>
            </Hinted>
          </>
        )}
        <MoreMenu compact={compact} />
        <FilePickers />
      </div>
      {compact && pills && <StagePills className="gap-1 overflow-x-auto px-4 pb-2" />}
    </header>
  );
}
