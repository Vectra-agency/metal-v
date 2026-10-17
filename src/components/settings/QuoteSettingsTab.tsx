// «КП и цены»: как часто обновлять цены mc.ru, реквизиты КП (шапка, подпись, срок, условия),
// округление цены за шт, что показывать в КП, и какой ИИ подключён на сервере (только для сведения).
import type { ReactElement } from 'react';
import { cn } from '@/lib/utils.ts';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { Sparkles } from '@/components/common/icons.ts';
import { NumInput } from '@/components/common/NumInput.tsx';
import { plural } from '@/format.ts';
import type { PieceRounding, QuoteSettings } from '@/quote.ts';
import { patchSettings, setQuoteSettings } from '@/store/actions.ts';
import { useStore } from '@/store/store.ts';
import { TextField } from './shared.tsx';

const ROUNDING: readonly [PieceRounding, string, string][] = [
  ['kop', 'коп.', 'До копеек'],
  ['rub', '1 ₽', 'До рубля'],
  ['ten', '10 ₽', 'До 10 ₽ (цены от 100 ₽)'],
];

type Flag = 'showMaterial' | 'showNotes' | 'showSketch' | 'amountInWords';
const FLAGS: readonly [Flag, string][] = [
  ['showMaterial', 'Материал и толщина'],
  ['showNotes', 'Примечания'],
  ['showSketch', 'Эскизы деталей'],
  ['amountInWords', 'Сумма прописью'],
];

function AiLine(): ReactElement | null {
  const server = useStore((s) => s.ai.server);
  if (!server) return null; // ещё не спросили сервер
  const on = server.configured && !!server.model;
  return (
    <p className="flex items-start gap-2 rounded-lg bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
      <Sparkles aria-hidden className={on ? 'mt-0.5 size-4 shrink-0 text-ai' : 'mt-0.5 size-4 shrink-0'} />
      <span className="min-w-0 break-words">{on ? `ИИ: ${server.model}${server.vision ? ', читает чертежи' : ''}` : 'ИИ не подключён на сервере'}</span>
    </p>
  );
}

export function QuoteSettingsTab(): ReactElement {
  const q = useStore((s) => s.quote);
  const maxAge = useStore((s) => s.settings.priceMaxAgeHours ?? 24);
  const set = (patch: Partial<QuoteSettings>) => setQuoteSettings(patch);

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <label className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
          Обновлять цены mc.ru старше
          <NumInput
            value={maxAge}
            min={1}
            max={8760}
            onChange={(v) => patchSettings({ priceMaxAgeHours: Math.round(v) })}
            aria-label="Обновлять цены mc.ru старше, ч"
            className="w-20"
          />
          ч
        </label>
        <p className="text-xs leading-normal text-muted-foreground">Перед расчётом заказа более старые цены листа загружаются с mc.ru заново.</p>
      </div>

      <FieldGroup className="gap-5 border-t pt-5">
        <Field>
          <FieldLabel htmlFor="set-q-header">Шапка КП</FieldLabel>
          <TextField
            id="set-q-header"
            multiline
            value={q.header}
            onCommit={(header) => set({ header })}
            placeholder="Компания, телефон, почта — как в начале КП"
            maxLength={1000}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="set-q-signature">Подпись</FieldLabel>
          <TextField id="set-q-signature" value={q.signature} onCommit={(signature) => set({ signature })} placeholder="Менеджер: …" maxLength={300} />
        </Field>
        <div className="flex flex-col gap-1.5">
          <label className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
            Цены действительны
            <NumInput
              value={q.validityDays}
              max={365}
              onChange={(v) => set({ validityDays: Math.round(v) })}
              aria-label="Цены действительны, рабочих дней"
              className="w-16"
            />
            {plural(q.validityDays, 'раб. день', 'раб. дня', 'раб. дней')}
          </label>
          <p className="text-xs leading-normal text-muted-foreground">0 — строку о сроке в КП не писать.</p>
        </div>
        <Field>
          <FieldLabel htmlFor="set-q-terms">Условия</FieldLabel>
          <TextField id="set-q-terms" value={q.terms} onCommit={(terms) => set({ terms })} placeholder="Срок изготовления — по согласованию" maxLength={500} />
        </Field>
      </FieldGroup>

      <div className="flex flex-col gap-1.5 border-t pt-5">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <span id="set-q-rounding" className="text-sm font-medium">
            Цена за шт в КП
          </span>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={0}
            value={q.rounding}
            onValueChange={(v) => v && set({ rounding: v as PieceRounding })}
            aria-labelledby="set-q-rounding"
          >
            {ROUNDING.map(([v, l, title]) => (
              <ToggleGroupItem
                key={v}
                value={v}
                title={title}
                aria-label={title}
                className={cn(
                  'px-3 tabular-nums pointer-coarse:h-9',
                  'data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary/90',
                )}
              >
                {l}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <p className="text-xs leading-normal text-muted-foreground">Итог КП — сумма строк с округлёнными ценами, поэтому он везде одинаковый.</p>
      </div>

      <div className="border-t pt-5">
        <FieldSet className="gap-3">
          <FieldLegend variant="label" className="mb-3">
            Показать в КП
          </FieldLegend>
          <FieldGroup className="gap-3">
            {FLAGS.map(([k, label]) => (
              <Field key={k} orientation="horizontal" className="justify-between">
                <FieldLabel htmlFor={`set-q-${k}`} className="font-normal">
                  {label}
                </FieldLabel>
                <Switch id={`set-q-${k}`} checked={q[k]} onCheckedChange={(on) => set({ [k]: on })} />
              </Field>
            ))}
          </FieldGroup>
          <FieldDescription className="text-xs">Эскизы и сумма прописью — только в печатном КП.</FieldDescription>
        </FieldSet>
      </div>

      <div className="border-t pt-5">
        <AiLine />
      </div>
    </div>
  );
}
