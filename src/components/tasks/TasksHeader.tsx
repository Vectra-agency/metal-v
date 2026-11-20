// Шапка экрана задач: марка, «← Расчёт» (заказ остаётся как был, анализ ИИ идёт дальше), кто вы на доске, тема и выход.
import type { ReactElement } from 'react';
import { ArrowLeft, LogOut, SunMoon, UserRound } from 'lucide-react';
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
import { useTheme, type Theme } from '@/components/ui/theme.ts';
import { Ellipsis } from '@/components/common/icons.ts';
import { Brand } from '@/components/shell/Header.tsx';
import { logout } from '@/history/api.ts';
import { getState, useStore } from '@/store/store.ts';
import { goCalc, patchTasks, useTasks } from '@/tasks/store.ts';
import { Person } from './shared.tsx';

const THEMES: { id: Theme; label: string }[] = [
  { id: 'light', label: 'Светлая' },
  { id: 'dark', label: 'Тёмная' },
  { id: 'system', label: 'Как в системе' },
];

export function TasksHeader(): ReactElement {
  const me = useTasks((s) => s.me);
  const auth = useStore((s) => s.history.auth.enabled);
  const { theme, setTheme } = useTheme();
  const back = () => {
    const tab = getState().ui.tab;
    goCalc(tab === 'positions' ? '' : `#${tab}`);
  };
  return (
    <header className="sticky top-0 z-40 shrink-0 border-b bg-background/90 backdrop-blur">
      <div className="flex h-14 items-center gap-2 px-4 lg:gap-3 lg:px-6">
        <Brand />
        <Button variant="ghost" onClick={back} className="max-sm:px-2">
          <ArrowLeft data-icon="inline-start" />
          Расчёт
        </Button>
        <Button
          variant="ghost"
          className="ms-auto min-w-0 max-sm:px-2"
          onClick={() => patchTasks({ naming: true })}
          title={me ? 'Ваше имя на доске — сменить' : 'Представиться: имя подписывает задачи и комментарии'}
        >
          {me ? <Person name={me} /> : <UserRound data-icon="inline-start" />}
          <span className="truncate">{me || 'Представиться'}</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Ещё">
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-56">
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
            {auth && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void logout()}>
                  <LogOut aria-hidden />
                  Выйти
                  <DropdownMenuShortcut className="tracking-normal">пароль спросим снова</DropdownMenuShortcut>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
