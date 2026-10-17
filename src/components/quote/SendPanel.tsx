// Панель «Отправка» на вкладке «Для клиента»: копирование, печать, CSV; «Перед отправкой» (сразу под кнопками —
// что ещё не проверено); что показать в КП; округление цены за шт; срок действия и условия.
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Card } from '@/components/ui/card.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { Separator } from '@/components/ui/separator.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { NumInput } from '@/components/common/NumInput.tsx';
import { TOGGLE_ON } from '@/components/money/MarkupControl.tsx';
import { cn } from '@/lib/utils.ts';
import { plural } from '@/format.ts';
import { Copy, FileSpreadsheet, Printer, TriangleAlert } from '@/components/common/icons.ts';
import { Table2 } from 'lucide-react';
import { ROUNDING_LABEL, type PieceRounding, type QuoteSettings } from '@/quote.ts';
import { openSheet, setQuoteQuestions, setQuoteSettings } from '@/store/actions.ts';
import { copyForClient, downloadClientCsv, printClient } from '@/store/quoteActions.ts';
import { useStore } from '@/store/store.ts';
import { BeforeSend } from './BeforeSend.tsx';

type Flag = 'showMaterial' | 'showNotes' | 'showSketch' | 'amountInWords';
const FLAGS: { key: Flag; label: string }[] = [
  { key: 'showMaterial', label: 'Материал и толщина' },
  { key: 'showNotes', label: 'Примечания' },
  { key: 'showSketch', label: 'Эскизы деталей' },
  { key: 'amountInWords', label: 'Сумма прописью' },
];
const ROUNDINGS: PieceRounding[] = ['kop', 'rub', 'ten'];

interface SwitchRowProps {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}

function SwitchRow({ id, label, checked, disabled, onChange }: SwitchRowProps) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-3">
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

const Heading = ({ id, children }: { id?: string; children: string }) => (
  <h3 id={id} className="text-sm font-semibold">
    {children}
  </h3>
);

export function SendPanel(): ReactElement {
  const qs = useStore((s) => s.quote);
  const questions = useStore((s) => (s.order.ai?.analysis.questions ?? []).filter((x) => x.trim()).length);
  const withQuestions = useStore((s) => s.ui.quoteQuestions);
  const set = (p: Partial<QuoteSettings>) => setQuoteSettings(p);

  return (
    <Card
      size="sm"
      className="gap-3.5 px-4 md:grid md:grid-cols-2 md:gap-x-8 xl:flex xl:max-h-[calc(100dvh-var(--header-h)-var(--strip-h)-4rem)] xl:overflow-y-auto"
    >
      {/* две колонки на планшете (отправка и проверка | что показать в КП), одна — в боковой панели от 1280 px */}
      <div className="flex min-w-0 flex-col gap-3.5">
        <section aria-labelledby="send-title" className="flex flex-col gap-2">
          <Heading id="send-title">Отправка</Heading>
          <Button onClick={() => void copyForClient('text')}>
            <Copy data-icon="inline-start" />
            Скопировать для клиента
          </Button>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 md:grid-cols-1">
            <Button variant="outline" onClick={() => void copyForClient('table')}>
              <Table2 data-icon="inline-start" />
              Скопировать таблицей
            </Button>
            <Button variant="outline" onClick={() => printClient()}>
              <Printer data-icon="inline-start" />
              Печать КП
            </Button>
            <Button variant="outline" onClick={() => downloadClientCsv()}>
              <FileSpreadsheet data-icon="inline-start" />
              Excel для клиента
            </Button>
          </div>
        </section>

        <Separator />

        <BeforeSend />
      </div>

      <div className="flex min-w-0 flex-col gap-3.5">
        <Separator className="md:hidden xl:block" />

        <section className="flex flex-col gap-0.5">
          <Heading>Показать в КП</Heading>
          {FLAGS.map((f) => (
            <SwitchRow key={f.key} id={`qs-${f.key}`} label={f.label} checked={qs[f.key]} onChange={(v) => set({ [f.key]: v })} />
          ))}
          <SwitchRow
            id="qs-questions"
            label={`Вопросы клиенту (${questions})`}
            checked={withQuestions && questions > 0}
            disabled={!questions}
            onChange={setQuoteQuestions}
          />
        </section>

        <Separator />

        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Heading>Цена за шт</Heading>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              spacing={0}
              value={qs.rounding}
              onValueChange={(v) => v && set({ rounding: v as PieceRounding })}
              aria-label="Округление цены за шт"
            >
              {ROUNDINGS.map((r) => (
                <ToggleGroupItem
                  key={r}
                  value={r}
                  className={cn('px-2.5', TOGGLE_ON)}
                >
                  {ROUNDING_LABEL[r]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>Цены действительны</span>
            <NumInput
              value={qs.validityDays}
              onChange={(v) => set({ validityDays: Math.round(v) })}
              max={365}
              aria-label="Цены действительны, рабочих дней"
              className="w-14"
            />
            <span>{plural(qs.validityDays, 'раб. день', 'раб. дня', 'раб. дней')}</span>
            {qs.validityDays === 0 && <span className="w-full text-xs text-muted-foreground">0 — срок в КП не указывается</span>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="qs-terms" className="font-normal">
              Условия
            </Label>
            <Input id="qs-terms" value={qs.terms} placeholder="Срок изготовления — по согласованию" onChange={(e) => set({ terms: e.target.value })} />
          </div>
          {!qs.header.trim() && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-warn/40 bg-warn-soft px-2.5 py-2 text-sm">
              <TriangleAlert aria-hidden className="size-4 shrink-0 text-warn" />
              <span>Шапка КП не заполнена</span>
              <Button variant="link" size="xs" className="ml-auto h-auto px-0" onClick={() => openSheet({ kind: 'settings', tab: 'quote' })}>
                Заполнить
              </Button>
            </div>
          )}
        </section>
      </div>
    </Card>
  );
}
