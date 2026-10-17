// Общее для вкладок «Расценок»: ключи строк таблиц, правка строк, текстовое поле с черновиком,
// кнопка удаления строки, числовое поле с подписью и фокус после добавления/удаления строки.
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { cn } from '@/lib/utils.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { focusNav } from '@/components/common/dom.ts';
import { X } from '@/components/common/icons.ts';
import { NumInput, type NumInputProps } from '@/components/common/NumInput.tsx';

/** Больше строк сервер ИИ не примет (rates.* ≤ 100) */
export const MAX_ROWS = 100;

// ---------- строки таблиц ----------

// у строк расценок нет id: ключ по ссылке на объект, правка строки переносит ключ на новый объект
const keys = new WeakMap<object, string>();
let seq = 0;

export function rowKey(o: object): string {
  let k = keys.get(o);
  if (!k) {
    k = `row${++seq}`;
    keys.set(o, k);
  }
  return k;
}

/** Строка i с правкой (тот же ключ — поле под фокусом не пересоздаётся) */
export function patchRow<T extends object>(rows: readonly T[], i: number, patch: Partial<T>): T[] {
  return rows.map((r, j) => {
    if (j !== i) return r;
    const next = { ...r, ...patch };
    keys.set(next, rowKey(r));
    return next;
  });
}

export const removeRow = <T,>(rows: readonly T[], i: number): T[] => rows.filter((_, j) => j !== i);

/** По возрастанию ключа (толщина, длина): таблица читается так же, как её читает расчёт (интерполяция по порядку) */
export const sortRows = <T,>(rows: readonly T[], by: (r: T) => number): T[] => rows.slice().sort((a, b) => by(a) - by(b));

export function moveRow<T>(rows: readonly T[], i: number, d: -1 | 1): T[] {
  const j = i + d;
  if (j < 0 || j >= rows.length) return rows.slice();
  const next = rows.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** Фокус после перерисовки: добавили строку — её первое поле; удалили — соседняя кнопка удаления или «+ строка» */
export function useRowFocus() {
  const ref = useRef<HTMLDivElement>(null);
  const afterDelete = (i: number) =>
    requestAnimationFrame(() => {
      const root = ref.current;
      if (!root) return;
      const del = root.querySelectorAll<HTMLButtonElement>('[data-row-del]:not(:disabled)');
      (del[Math.min(i, del.length - 1)] ?? root.querySelector<HTMLElement>('[data-row-add]'))?.focus();
    });
  const afterAdd = (col: string, row: number) => requestAnimationFrame(() => focusNav(col, row));
  return { ref, afterDelete, afterAdd };
}

export function RowDelete({ onClick, disabled }: { onClick: () => void; disabled?: boolean }): ReactElement {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label="Удалить строку"
      title={disabled ? 'Нужна хотя бы одна строка' : 'Удалить строку'}
      data-row-del=""
      disabled={disabled}
      onClick={onClick}
      className="text-muted-foreground hover:text-destructive pointer-coarse:size-9"
    >
      <X />
    </Button>
  );
}

/** «+ строка» / «+ операция» */
export function AddRow({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }): ReactElement {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-row-add=""
      disabled={disabled}
      title={disabled ? `Не больше ${MAX_ROWS} строк` : undefined}
      onClick={onClick}
      className="pointer-coarse:h-9"
    >
      {children}
    </Button>
  );
}

// ---------- поля ----------

export interface TextFieldProps {
  value: string;
  onCommit: (v: string) => void;
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  placeholder?: string;
  maxLength?: number;
  multiline?: boolean; // Textarea: Enter — новая строка, Ctrl/⌘+Enter — применить
  size?: 'sm' | 'default'; // sm — h-7, 13 px (таблицы)
  invalid?: boolean;
  navCol?: string; // Enter → то же поле следующей строки
  navRow?: number;
  className?: string;
}

/** Текст применяется при уходе из поля и по Enter (не на каждую букву: расценки пересчитывают заказ); Esc — вернуть как было */
export function TextField(props: TextFieldProps): ReactElement {
  const { value, onCommit, multiline, size = 'default', invalid, navCol, navRow, className } = props;
  const [draft, setDraftState] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const setDraft = (v: string | null) => {
    draftRef.current = v;
    setDraftState(v);
  };
  const latest = useRef({ value, onCommit });
  latest.current = { value, onCommit };

  const commit = () => {
    const d = draftRef.current;
    if (d == null) return;
    setDraft(null);
    const v = d.trim();
    if (v !== latest.current.value) latest.current.onCommit(v);
  };

  // панель закрыли, пока поле под фокусом (blur при размонтировании не приходит)
  useEffect(
    () => () => {
      const d = draftRef.current;
      draftRef.current = null;
      if (d != null && d.trim() !== latest.current.value) latest.current.onCommit(d.trim());
    },
    [],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      setDraft(null);
      e.currentTarget.blur();
    } else if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      commit();
      if (navCol == null || navRow == null || !focusNav(navCol, navRow + 1)) e.currentTarget.blur();
    }
  };

  const common = {
    id: props.id,
    value: draft ?? value,
    placeholder: props.placeholder,
    maxLength: props.maxLength,
    title: size === 'sm' && value ? value : undefined, // в узкой ячейке текст обрезан — полностью в подсказке
    'aria-label': props['aria-label'],
    'aria-describedby': props['aria-describedby'],
    'aria-invalid': (invalid && draft == null) || undefined, // пока пишут — без красной рамки
    'data-nav-col': navCol,
    'data-nav-row': navRow,
    onFocus: () => setDraft(value),
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown,
  };
  if (multiline) return <Textarea {...common} className={cn('min-h-20 resize-y', className)} />;
  return (
    <Input
      {...common}
      autoComplete="off"
      className={cn('pointer-coarse:h-9', size === 'sm' && 'h-7 rounded-[min(var(--radius-md),10px)] px-2 text-[13px] md:text-[13px]', className)}
    />
  );
}

/** Числовое поле с подписью слева и пояснением под ней; щелчок по подписи ставит курсор в поле */
export function NumField({ label, hint, ...num }: { label: string; hint?: ReactNode } & Omit<NumInputProps, 'aria-label'>): ReactElement {
  return (
    <label className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-6 gap-y-1">
      <span className="pt-1.5 text-sm leading-snug font-medium">{label}</span>
      <NumInput aria-label={label} {...num} className={cn('row-span-2 w-28', num.className)} />
      {hint && <span className="text-xs leading-normal text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** Пояснение над таблицей или под ней */
export function Hint({ children, className }: { children: ReactNode; className?: string }): ReactElement {
  return <p className={cn('text-sm leading-normal text-muted-foreground', className)}>{children}</p>;
}

/** Классы плотной таблицы расценок; TDN — ячейка с числом под правым заголовком (поле прижато вправо) */
export const TH = 'h-8 px-2 text-xs font-medium text-muted-foreground';
export const TD = 'px-2 py-1';
export const TDN = 'px-2 py-1 text-right';
