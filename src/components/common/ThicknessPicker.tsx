// Выбор толщины: типовые толщины материала + своя («2,7» → «Толщина 2,7 мм»). Enter — выбрать, Esc — закрыть.
import { useMemo, useState, type ReactElement } from 'react';
import { cn } from '@/lib/utils.ts';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { getMaterial } from '@/core/materials.ts';
import { n1, thick } from '@/format.ts';
import { AI_CLASS, GUESSED_CLASS, GuessedIcon, GuessedTooltip, useGuessedDescription } from './guessed.tsx';
import { ChevronDown } from './icons.ts';
import { parseNum } from './NumInput.tsx';

export interface ThicknessPickerProps {
  materialId: string;
  value: number | null; // null — не выбрана («—»)
  onChange: (t: number) => void;
  size?: 'sm' | 'default';
  guessed?: boolean;
  ai?: boolean;
  'aria-label'?: string; // по умолчанию «Толщина»
  className?: string;
}

const sameT = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const keyOf = (t: number) => `t:${t}`;

export function ThicknessPicker({ materialId, value, onChange, size = 'default', guessed, ai, className, ...rest }: ThicknessPickerProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState('');
  const desc = useGuessedDescription(guessed);

  const mat = getMaterial(materialId);
  const list = useMemo(() => {
    const all = [...mat.thicknesses, ...(value != null && value > 0 ? [value] : [])].sort((a, b) => a - b);
    return all.filter((t, i) => i === 0 || !sameT(t, all[i - 1]));
  }, [mat, value]);

  const query = q.trim().replace('.', ',');
  const typed = parseNum(q);
  const custom = typed != null && typed > 0 && typed <= 100 && !list.some((t) => sameT(t, typed)) ? typed : null;
  const shown = query ? list.filter((t) => n1(t).startsWith(query)) : list;

  const setQuery = (v: string) => {
    setQ(v);
    // подсветка — на первом варианте: своя толщина, иначе первая подходящая
    const t = parseNum(v);
    const cust = t != null && t > 0 && t <= 100 && !list.some((x) => sameT(x, t));
    const qq = v.trim().replace('.', ',');
    const first = list.find((x) => n1(x).startsWith(qq));
    setActive(cust ? 'custom' : first != null ? keyOf(first) : '');
  };
  const onOpenChange = (o: boolean) => {
    setOpen(o);
    setQ('');
    setActive(value != null ? keyOf(value) : '');
  };
  const pick = (t: number) => {
    onOpenChange(false);
    if (value == null || !sameT(t, value)) onChange(t);
  };

  const sm = size === 'sm';
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <GuessedTooltip guessed={guessed}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`${rest['aria-label'] ?? 'Толщина'}: ${value != null ? thick(value) : 'не выбрана'}`}
            aria-describedby={desc.id}
            className={cn(
              'flex w-fit min-w-0 items-center justify-between gap-1 rounded-lg border border-input bg-transparent pr-2 pl-2.5',
              'text-sm whitespace-nowrap transition-colors outline-none select-none',
              'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
              'dark:bg-input/30 dark:hover:bg-input/50',
              'aria-expanded:border-ring',
              sm ? 'h-7 gap-0.5 rounded-[min(var(--radius-md),10px)] pr-1 pl-2 text-[13px]' : 'h-8',
              'pointer-coarse:h-9',
              guessed && GUESSED_CLASS,
              ai && AI_CLASS,
              className,
            )}
          >
            {guessed && <GuessedIcon />}
            <span className={cn('truncate tabular-nums', value == null && 'text-muted-foreground')}>{value != null ? thick(value) : '—'}</span>
            <ChevronDown aria-hidden className={cn('shrink-0 text-muted-foreground', sm ? 'size-3.5' : 'size-4')} />
            {desc.node}
          </button>
        </PopoverTrigger>
      </GuessedTooltip>
      <PopoverContent align="start" className="w-48 p-0">
        <Command shouldFilter={false} value={active} onValueChange={setActive} label="Толщина, мм">
          <CommandInput placeholder="Другая, мм" value={q} onValueChange={setQuery} inputMode="decimal" />
          <CommandList>
            {custom != null && (
              <CommandItem value="custom" onSelect={() => pick(custom)}>
                Толщина {thick(custom)}
              </CommandItem>
            )}
            {shown.map((t) => (
              <CommandItem key={t} value={keyOf(t)} onSelect={() => pick(t)} data-checked={value != null && sameT(t, value)} className="tabular-nums">
                {thick(t)}
              </CommandItem>
            ))}
            <CommandEmpty>Введите толщину, например 2,7</CommandEmpty>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
