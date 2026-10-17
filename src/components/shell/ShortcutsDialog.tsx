// «Горячие клавиши» (ui-spec §2.18): ровно таблица клавиш приложения; на macOS — ⌘ вместо Ctrl.
import type { ReactElement, ReactNode } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx';
import { Kbd, KbdGroup } from '@/components/ui/kbd.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx';
import { closeDialog } from '@/store/actions.ts';
import { useStore } from '@/store/store.ts';
import { MOD } from './useShortcuts.ts';

const keys = (...k: string[]): ReactNode => (
  <KbdGroup>
    {k.map((x, i) => (x === '/' && i > 0 ? <span key={i} className="text-muted-foreground">/</span> : <Kbd key={i}>{x}</Kbd>))}
  </KbdGroup>
);

const ROWS: { keys: ReactNode; where: string; what: string }[] = [
  { keys: keys(`${MOD}+O`), where: 'везде', what: 'выбрать файлы' },
  { keys: keys(`${MOD}+P`), where: 'везде', what: 'печать КП' },
  { keys: keys('/'), where: 'вне полей ввода, экран расчёта', what: 'вкладка «Позиции» и поиск' },
  { keys: keys('?'), where: 'вне полей ввода', what: 'эта справка' },
  { keys: keys('Esc'), where: 'панель или окно', what: 'сначала вернуть значение поля, затем закрыть; заканчивает разбор замечаний' },
  { keys: keys('↑', '/', '↓'), where: 'карточка позиции (не в поле ввода)', what: 'соседняя позиция; при разборе — предыдущее / следующее замечание' },
  { keys: keys('J', '/', 'K'), where: 'разбор замечаний', what: 'следующее / предыдущее замечание' },
  { keys: keys('Enter', '/', 'Esc'), where: 'число в таблице', what: 'применить и перейти вниз по столбцу / вернуть как было' },
  { keys: keys('↑', '↓', 'Enter', 'Пробел'), where: 'строка таблицы в фокусе', what: 'перейти по строкам / открыть карточку / отметить' },
  { keys: keys(`${MOD}+V`), where: 'пустой экран и экран обработки', what: 'текст — в «Заявку клиента», файлы — в заказ' },
];

export function ShortcutsDialog(): ReactElement | null {
  const open = useStore((s) => s.ui.dialog?.kind === 'shortcuts');
  if (!open) return null;
  return (
    <Dialog open onOpenChange={(o) => !o && closeDialog()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Горячие клавиши</DialogTitle>
          <DialogDescription>Других клавиш-букв нет — печатать в полях можно спокойно.</DialogDescription>
        </DialogHeader>
        <div className="-mx-1 max-h-[70dvh] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Клавиши</TableHead>
                <TableHead>Где</TableHead>
                <TableHead>Что делает</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ROWS.map((r, i) => (
                <TableRow key={i}>
                  <TableCell className="align-top whitespace-nowrap">{r.keys}</TableCell>
                  <TableCell className="align-top whitespace-normal text-muted-foreground">{r.where}</TableCell>
                  <TableCell className="align-top whitespace-normal">{r.what}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
  );
}
