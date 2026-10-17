// Числовое поле: принимает запятую, применяет по Enter и при уходе из поля, Esc — вернуть как было,
// при фокусе выделяет текст. Enter в таблице переводит фокус на то же поле следующей строки.
import { useRef, useState, type ChangeEvent, type FocusEvent, type KeyboardEvent, type ReactElement } from 'react';
import { cn } from '@/lib/utils.ts';
import { Input } from '@/components/ui/input.tsx';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group.tsx';
import { focusNav } from './dom.ts';
import { AI_CLASS, GUESSED_CLASS, GuessedIcon, GuessedTooltip, useGuessedDescription } from './guessed.tsx';

export interface NumInputProps {
  value: number;
  onChange: (v: number) => void;
  'aria-label': string;
  min?: number; // по умолчанию 0; меньше — значение не принимается
  max?: number; // больше — ставится max
  allowEmpty?: boolean; // пусто → onChange(0); значение 0 показывается пустым
  placeholder?: string;
  suffix?: string; // «мм», «₽», «%», «₽/кг»
  size?: 'sm' | 'default'; // sm — h-7, 13 px (таблицы); default — h-8; на сенсорном экране — h-9
  className?: string; // ширина, например 'w-14'
  guessed?: boolean; // значение не найдено в файле
  ai?: boolean; // значение изменено ИИ
  title?: string;
  disabled?: boolean;
  navCol?: string; // data-nav-col: Enter → то же поле в следующей строке
  navRow?: number; // data-nav-row
  onEnter?: () => void; // после применения по Enter (вместо перехода по navCol/navRow)
}

/** Число для поля: запятая, без лишних нулей */
export function fmtNum(v: number, allowEmpty?: boolean): string {
  if (allowEmpty && !v) return '';
  return String(Math.round(v * 1000) / 1000).replace('.', ',');
}

/** Текст поля → число: пробелы, единицы и знак «−» допускаются; не число — null */
export function parseNum(text: string): number | null {
  const t = text
    .replace(/−/g, '-')
    .replace(/[^\d.,+-]/g, '')
    .replace(',', '.');
  if (!t) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

export function NumInput(props: NumInputProps): ReactElement {
  const { value, onChange, min = 0, max, allowEmpty, placeholder, suffix, size = 'default', className } = props;
  const { guessed, ai, title, disabled, navCol, navRow, onEnter } = props;
  // черновик только во время ввода; иначе показывается value (внешние изменения видны сразу)
  const [draft, setDraftState] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const setDraft = (v: string | null) => {
    draftRef.current = v;
    setDraftState(v);
  };
  const desc = useGuessedDescription(guessed);

  const commit = () => {
    const d = draftRef.current;
    if (d == null) return;
    setDraft(null);
    if (!d.trim()) {
      if (allowEmpty && value !== 0) onChange(0);
      return;
    }
    let v = parseNum(d);
    if (v == null || v < min) return; // не принято — остаётся прежнее значение
    if (max != null && v > max) v = max;
    if (v !== value) onChange(v);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
      if (onEnter) onEnter();
      else if (navCol == null || navRow == null || !focusNav(navCol, navRow + 1)) e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      setDraft(null);
      e.currentTarget.blur();
    }
  };

  const sm = size === 'sm';
  const inputProps = {
    inputMode: 'decimal' as const,
    value: draft ?? fmtNum(value, allowEmpty),
    placeholder,
    disabled,
    title,
    'aria-label': props['aria-label'],
    'aria-describedby': desc.id,
    'data-nav-col': navCol,
    'data-nav-row': navRow,
    onFocus: (e: FocusEvent<HTMLInputElement>) => {
      setDraft(fmtNum(value, allowEmpty));
      e.currentTarget.select();
    },
    onChange: (e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown,
  };
  // на сенсорном экране поле выше (≈ палец): h-9
  const textCls = cn('text-right tabular-nums pointer-coarse:h-9', sm && 'h-7 text-[13px] md:text-[13px]');

  // без единиц и без значка — обычное поле
  if (!suffix && !guessed) {
    return <Input {...inputProps} className={cn(textCls, sm && 'rounded-[min(var(--radius-md),10px)] px-1.5', ai && AI_CLASS, className)} />;
  }
  return (
    <GuessedTooltip guessed={guessed}>
      <InputGroup
        data-slot="input-group" // иначе подсказка (asChild) подменит data-slot на tooltip-trigger
        data-disabled={disabled || undefined}
        className={cn('pointer-coarse:h-9', sm && 'h-7 rounded-[min(var(--radius-md),10px)]', guessed && GUESSED_CLASS, ai && AI_CLASS, className)}
      >
        {guessed && (
          <InputGroupAddon align="inline-start" className={cn(sm && 'pl-1.5')}>
            <GuessedIcon />
            {desc.node}
          </InputGroupAddon>
        )}
        <InputGroupInput {...inputProps} className={cn(textCls, sm ? 'px-1.5' : 'px-2', 'min-w-0')} />
        {suffix && (
          <InputGroupAddon align="inline-end" className={cn(sm && 'pr-1.5')}>
            <InputGroupText className={cn('text-xs font-normal', sm && 'text-[11px]')}>{suffix}</InputGroupText>
          </InputGroupAddon>
        )}
      </InputGroup>
    </GuessedTooltip>
  );
}
