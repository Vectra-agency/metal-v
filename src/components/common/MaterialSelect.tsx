// Выбор материала: в поле — короткое имя («08пс х/к»), в списке — полное («08пс холоднокатаный»).
import type { ReactElement } from 'react';
import { cn } from '@/lib/utils.ts';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.tsx';
import { MATERIAL_BY_ID, MATERIALS } from '@/core/materials.ts';
import { AI_CLASS, GUESSED_CLASS, GuessedIcon, GuessedTooltip, useGuessedDescription } from './guessed.tsx';

export interface MaterialSelectProps {
  value: string | null; // null — не выбран (массовая правка: «—»)
  onChange: (id: string) => void;
  size?: 'sm' | 'default';
  guessed?: boolean;
  ai?: boolean;
  placeholder?: string;
  'aria-label'?: string; // по умолчанию «Материал»
  className?: string;
}

export function MaterialSelect({ value, onChange, size = 'default', guessed, ai, placeholder = '—', className, ...rest }: MaterialSelectProps): ReactElement {
  const m = value ? MATERIAL_BY_ID.get(value) : undefined;
  const desc = useGuessedDescription(guessed);
  return (
    <Select value={value ?? ''} onValueChange={(v) => v && v !== value && onChange(v)}>
      <GuessedTooltip guessed={guessed}>
        <SelectTrigger
          data-slot="select-trigger" // иначе подсказка (asChild) подменит data-slot на tooltip-trigger
          size={size}
          aria-label={rest['aria-label'] ?? 'Материал'}
          aria-describedby={desc.id}
          title={guessed ? undefined : m?.label}
          className={cn(
            'min-w-0 gap-1 pointer-coarse:data-[size=default]:h-9 pointer-coarse:data-[size=sm]:h-9',
            size === 'sm' && 'gap-0.5 pr-1 pl-2 text-[13px] [&>svg:last-child]:size-3.5',
            guessed && GUESSED_CLASS,
            ai && AI_CLASS,
            className,
          )}
        >
          {guessed && <GuessedIcon />}
          <SelectValue placeholder={placeholder}>{m?.short}</SelectValue>
          {desc.node}
        </SelectTrigger>
      </GuessedTooltip>
      <SelectContent position="popper" align="start">
        {MATERIALS.map((x) => (
          <SelectItem key={x.id} value={x.id}>
            {x.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
