// Вкладка «Цены mc.ru» (ui-spec §2.12): цена каждой группы, источник, когда получена, ссылка на mc.ru;
// в раскрытой строке — все форматы листа с металлом группы (выбор — тот же, что «Лист» на вкладке «Металл и раскрой»).
import { Fragment, useState, type ReactElement } from 'react';
import { cn } from '@/lib/utils.ts';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx';
import { ChevronRight, CircleCheck, ExternalLink, Info, Pencil, RefreshCw, TriangleAlert } from '@/components/common/icons.ts';
import { AUTO } from '@/components/metal/GroupCard.tsx';
import { useNow, usePriceRefresh } from '@/components/shell/StageList.tsx';
import { fmtSheet, type GroupResult, type PriceBook, type SheetOffer, type SheetOption } from '@/core/pricing.ts';
import { ago, date, dateDay, dateShort, hhmm, n2, pct, rub0, thick } from '@/format.ts';
import { mcUrl } from '@/mcUrl.ts';
import { pairAge, pairFetchedAt } from '@/prices.ts';
import { setSheetChoice } from '@/store/actions.ts';
import { useDerived } from '@/store/derived.tsx';
import { refreshPrices } from '@/store/pipelineActions.ts';
import { useStore } from '@/store/store.ts';

const num = 'text-right tabular-nums whitespace-nowrap';

function SourceBadge({ source }: { source: SheetOffer['source'] }): ReactElement {
  if (source === 'mc') {
    return (
      <Badge variant="outline">
        <CircleCheck aria-hidden className="text-ok" />
        mc.ru
      </Badge>
    );
  }
  if (source === 'estimate') {
    return (
      <Badge variant="outline" className="border-warn/50 text-warn">
        <TriangleAlert aria-hidden />
        оценка
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground">
      <Pencil aria-hidden />
      вручную
    </Badge>
  );
}

/** «16.10 14:05 · 2 ч назад»; старше допустимого — «16.10, 3 дн. назад» со значком */
function Fetched({ book, g, maxAge, now }: { book: PriceBook; g: GroupResult; maxAge: number; now: number }): ReactElement {
  const at = pairFetchedAt(book, g.material.id, g.t);
  if (!at) return <span className="text-muted-foreground">—</span>;
  if (pairAge(book, g.material.id, g.t, now) > maxAge) {
    return (
      <span className="inline-flex items-center gap-1 text-warn" title={`Старше ${maxAge} ч`}>
        <TriangleAlert aria-hidden className="size-3.5" />
        {dateDay(at).slice(0, 5)}, {ago(at, now)}
      </span>
    );
  }
  return (
    <span>
      {dateShort(at)} · <span className="text-muted-foreground">{ago(at, now)}</span>
    </span>
  );
}

function OptionRow({ id, value, label, o, chosen }: { id: string; value: string; label: string; o: SheetOption; chosen: boolean }): ReactElement {
  const split = Object.keys(o.splits).length;
  return (
    <TableRow data-state={chosen ? 'selected' : undefined}>
      <TableCell className="pl-3">
        <label htmlFor={id} className="flex cursor-pointer items-center gap-2">
          <RadioGroupItem id={id} value={value} />
          <span className="tabular-nums">{label}</span>
        </label>
      </TableCell>
      <TableCell className={num}>{n2(o.offer.pricePerKg)}</TableCell>
      <TableCell className={num}>{rub0(o.materialCost)}</TableCell>
      <TableCell className={num}>{n2(o.sheetsCharged)}</TableCell>
      <TableCell className={num}>{pct(o.nest.utilization)}</TableCell>
      <TableCell className={cn(num, 'pr-3', split && 'text-warn')}>{split ? `${split} поз.` : '—'}</TableCell>
    </TableRow>
  );
}

function Options({ g }: { g: GroupResult }): ReactElement {
  const choice = useStore((s) => s.order.sheetChoice[g.key]);
  const value = choice ?? AUTO;
  const auto = fmtSheet(g.auto.offer.w, g.auto.offer.l);
  return (
    <RadioGroup value={value} onValueChange={(v) => setSheetChoice(g.key, v === AUTO ? null : v)} aria-label={`Лист для «${g.material.label} ${thick(g.t)}»`} className="block">
      <div className="overflow-x-auto rounded-lg border bg-background">
        <Table className="text-[13px]">
          <TableHeader>
            <TableRow>
              <TableHead className="pl-3">Формат</TableHead>
              <TableHead className="text-right">₽/кг</TableHead>
              <TableHead className="text-right">Металл группы</TableHead>
              <TableHead className="text-right">Листов</TableHead>
              <TableHead className="text-right">Заполнение</TableHead>
              <TableHead className="pr-3 text-right">Не влезают</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <OptionRow id={`${g.key}-auto`} value={AUTO} label={`Авто (${auto})`} o={g.auto} chosen={value === AUTO} />
            {g.options.map((o) => {
              const k = fmtSheet(o.offer.w, o.offer.l);
              return <OptionRow key={k} id={`${g.key}-${k}`} value={k} label={k} o={o} chosen={value === k} />;
            })}
          </TableBody>
        </Table>
      </div>
    </RadioGroup>
  );
}

function RefreshButton(): ReactElement {
  const r = usePriceRefresh();
  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" disabled={r.disabled} onClick={() => void refreshPrices()}>
        {r.busy ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
        Обновить цены заказа
      </Button>
      {r.busy && <span className="text-xs text-muted-foreground tabular-nums">{r.busy}</span>}
      {r.note && <span className="text-xs text-muted-foreground">{r.note}</span>}
    </div>
  );
}

function IssueAlert(): ReactElement | null {
  const issue = useStore((s) => s.prices.issue);
  const blockedUntil = useStore((s) => s.prices.blockedUntil);
  const now = useNow(!!blockedUntil, 30_000);
  if (!issue) return null;
  const blocked = !!blockedUntil && blockedUntil > now;
  const antiBot = /не робот|check-human/i.test([issue.reason, ...issue.errors].join(' '));
  const text =
    antiBot && blockedUntil
      ? `mc.ru попросил проверку «я не робот» — обновление остановлено, полученные цены сохранены.${blocked ? ` Можно повторить в ${hhmm(blockedUntil)}.` : ''}`
      : issue.reason;
  const errors = issue.errors.filter((e) => e !== issue.reason).slice(0, 3);
  return (
    <Alert className="border-warn/40 bg-warn-soft">
      <TriangleAlert className="text-warn" />
      <AlertTitle>{/част/i.test(issue.reason) ? 'Цены mc.ru обновлены не все' : 'Цены mc.ru не обновлены'}</AlertTitle>
      <AlertDescription className="text-foreground/80">
        <p>{text}</p>
        {errors.length > 0 && (
          <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}
      </AlertDescription>
    </Alert>
  );
}

export function PricesTab(): ReactElement {
  const { res } = useDerived();
  const book = useStore((s) => s.prices.book);
  const live = useStore((s) => s.prices.live);
  const loaded = useStore((s) => s.prices.loaded);
  const maxAge = useStore((s) => s.settings.priceMaxAgeHours ?? 24);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const now = useNow(true, 60_000);
  const toggle = (key: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Цены металла · mc.ru · {book.region}</h2>
          <p className="text-xs text-muted-foreground">
            справочник от {date(book.updatedAt)} · обновляются перед расчётом, если старше {maxAge} ч
          </p>
        </div>
        <RefreshButton />
      </div>

      {loaded && !live && (
        <Alert>
          <Info />
          <AlertDescription>Статическая версия: цены из снимка от {dateDay(book.updatedAt)}, обновление недоступно</AlertDescription>
        </Alert>
      )}
      <IssueAlert />

      {res.groups.length ? (
        <div role="region" aria-label="Цены групп металла" className="overflow-x-auto rounded-xl border bg-card">
          <Table className="text-[13px]">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-3">Материал · толщина</TableHead>
                <TableHead>Лист в расчёте</TableHead>
                <TableHead className="text-right">₽/кг</TableHead>
                <TableHead>Источник</TableHead>
                <TableHead>Получено</TableHead>
                <TableHead className="pr-4 text-right">
                  <span className="sr-only">Ссылка</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {res.groups.map((g) => {
                const c = g.chosen;
                const isOpen = open.has(g.key);
                const panel = `prices-${g.key}`;
                return (
                  <Fragment key={g.key}>
                    <TableRow data-group={g.key} className={cn(isOpen && 'border-b-0 bg-muted/40')}>
                      <TableCell className="pl-1.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-expanded={isOpen}
                          aria-controls={panel}
                          onClick={() => toggle(g.key)}
                          className="gap-1.5 px-1.5 font-normal"
                        >
                          <ChevronRight aria-hidden className={cn('transition-transform', isOpen && 'rotate-90')} />
                          <span className="font-medium">{g.material.label}</span>
                          <span className="tabular-nums">· {thick(g.t)}</span>
                        </Button>
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {fmtSheet(c.offer.w, c.offer.l)} <span className="text-muted-foreground">· {g.autoChosen ? 'авто' : 'вручную'}</span>
                      </TableCell>
                      <TableCell className={num}>{n2(c.offer.pricePerKg)}</TableCell>
                      <TableCell>
                        <SourceBadge source={c.offer.source} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        <Fetched book={book} g={g} maxAge={maxAge} now={now} />
                      </TableCell>
                      <TableCell className="pr-4 text-right">
                        <a
                          href={mcUrl(g.material.mc.category, g.t)}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 whitespace-nowrap text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-ring"
                        >
                          mc.ru
                          <ExternalLink aria-hidden className="size-3" />
                          <span className="sr-only">: {g.material.label} {thick(g.t)} (откроется сайт)</span>
                        </a>
                      </TableCell>
                    </TableRow>
                    {isOpen && (
                      <TableRow id={panel} className="bg-muted/40 hover:bg-muted/40">
                        <TableCell colSpan={6} className="px-3 pt-0 pb-3 whitespace-normal">
                          <Options g={g} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="py-6 text-sm text-muted-foreground">Нет позиций в расчёте — цен пока нечего показать.</p>
      )}

      <p className="text-xs text-muted-foreground">
        mc.ru — склад СПб, «от 1 т», медиана по формату · оценка — нужной толщины нет на mc.ru, взята ближайшая · вручную — ваша цена ₽/кг
      </p>
    </div>
  );
}
