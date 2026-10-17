// Пустой экран (ui-spec §2.4): зона загрузки, «Заявка клиента», строка о сервисах (цены, ИИ).
// После разбора без чертежей (projects/1) — сверху пояснение: что прочитано и что пропущено.
import { useMemo, type MouseEvent, type ReactElement } from 'react';
import { cn } from '@/lib/utils.ts';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.tsx';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty.tsx';
import { Kbd } from '@/components/ui/kbd.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { CircleX, FileUp, FolderUp, Info, Pencil, Sparkles, TriangleAlert } from '@/components/common/icons.ts';
import { AI_LIMITS } from '@/core/ai.ts';
import { dateDay, dateShort, n0 } from '@/format.ts';
import type { JournalEntry } from '@/order.ts';
import { openDialog } from '@/store/actions.ts';
import { setRequest } from '@/store/pipelineActions.ts';
import { useStore } from '@/store/store.ts';
import { openFilePicker, openFolderPicker } from './FilePickers.tsx';
import { MOD } from './useShortcuts.ts';

const SHOWN = 8;

export function JournalIcon({ level, className }: { level: JournalEntry['level']; className?: string }): ReactElement {
  const cls = cn('mt-0.5 size-3.5 shrink-0', className);
  if (level === 'error') return <CircleX aria-label="ошибка" className={cn(cls, 'text-danger')} />;
  if (level === 'warn') return <TriangleAlert aria-label="внимание" className={cn(cls, 'text-warn')} />;
  return <Info aria-label="для сведения" className={cn(cls, 'text-muted-foreground')} />;
}

/** Разбор не нашёл чертежей: что прочитано и что пропущено (журнал последнего разбора) */
function NoDrawingsAlert(): ReactElement | null {
  const show = useStore((s) => s.pipeline.emptyResult);
  const journal = useStore((s) => s.order.journal);
  const from = useStore((s) => s.pipeline.stages.files.startedAt);
  const docs = useStore((s) => (s.order.documents ?? []).length);
  const entries = useMemo(() => (journal ?? []).filter((e) => from == null || Date.parse(e.at) >= from), [journal, from]);
  if (!show) return null;
  const rest = entries.length - SHOWN;
  return (
    <Alert className="mb-6 border-warn/40 bg-warn-soft">
      <TriangleAlert className="text-warn" />
      <AlertTitle>В файлах не нашлось чертежей</AlertTitle>
      <AlertDescription className="text-foreground/80">
        <ul className="mt-1 flex flex-col gap-1">
          {entries.slice(0, SHOWN).map((e, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <JournalIcon level={e.level} />
              <span>{e.text}</span>
            </li>
          ))}
          {rest > 0 && <li className="text-muted-foreground">… ещё {rest}</li>}
        </ul>
        {docs > 0 && <p className="mt-2">Документы сохранены — их увидит ИИ, когда добавите чертежи.</p>}
      </AlertDescription>
    </Alert>
  );
}

function Dropzone(): ReactElement {
  // щелчок по фону зоны — выбор файлов (кнопки внутри работают сами)
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button, a, input')) return;
    openFilePicker();
  };
  return (
    <Empty
      onClick={onClick}
      className="cursor-pointer rounded-2xl border-2 border-dashed p-10 transition-colors hover:border-foreground/25 hover:bg-muted/30"
    >
      <EmptyHeader>
        <EmptyMedia variant="icon" className="size-11 rounded-xl [&_svg:not([class*='size-'])]:size-5">
          <FolderUp />
        </EmptyMedia>
        <EmptyTitle className="text-base">Перетащите папку заказа или чертежи DXF/PDF</EmptyTitle>
        <EmptyDescription>Можно всё сразу — чертежи, текст заявки (.txt), счета. Лишнее пропустим и скажем, что именно.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-none">
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={openFilePicker}>
            <FileUp data-icon="inline-start" />
            Выбрать файлы
            <Kbd className="ml-1 bg-primary-foreground/15 text-primary-foreground">{MOD} O</Kbd>
          </Button>
          <Button variant="outline" onClick={openFolderPicker}>
            <FolderUp data-icon="inline-start" />
            Выбрать папку
          </Button>
          <Button variant="ghost" onClick={() => openDialog({ kind: 'manual' })}>
            <Pencil data-icon="inline-start" />
            Деталь без чертежа
          </Button>
        </div>
        <p className="max-w-md text-xs text-muted-foreground">
          Подсказка в имени DXF: «НГЭН.745421.0001 st3 s2mm 5sht.dxf» — обозначение, материал, толщина, количество.
        </p>
      </EmptyContent>
    </Empty>
  );
}

/** Счётчик символов заявки: «1 234 / 8 000» */
export function RequestCounter({ len, className }: { len: number; className?: string }): ReactElement {
  const over = len > AI_LIMITS.requestChars;
  return (
    <span className={cn('whitespace-nowrap tabular-nums', over && 'text-warn', className)}>
      {n0(len)} / {n0(AI_LIMITS.requestChars)}
    </span>
  );
}

function RequestCard(): ReactElement {
  const request = useStore((s) => s.order.request ?? '');
  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <label htmlFor="request-input">Заявка клиента</label>
          <Badge variant="secondary">необязательно</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Textarea
          id="request-input"
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          placeholder="Вставьте текст письма: «Прошу счёт… БВС-305Х300.000 — 3 шт»"
          className="max-h-[50dvh] min-h-40 resize-y overflow-y-auto"
          spellCheck={false}
        />
        <div className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
          <p>ИИ сверит количество и обозначения с чертежами. {MOD}+V в любом месте окна вставит текст сюда.</p>
          <RequestCounter len={request.length} />
        </div>
      </CardContent>
    </Card>
  );
}

function ServicesLine(): ReactElement {
  const loaded = useStore((s) => s.prices.loaded);
  const live = useStore((s) => s.prices.live);
  const book = useStore((s) => s.prices.book);
  const server = useStore((s) => s.ai.server);
  return (
    <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className={cn('inline-block size-1.5 rounded-full', loaded && live ? 'bg-ok' : 'bg-muted-foreground/60')} />
        {!loaded ? 'Цены: загружаю…' : live ? `Цены mc.ru: ${book.region}, ${dateShort(book.updatedAt)}` : `Цены: снимок от ${dateDay(book.updatedAt)} (без сервера)`}
      </span>
      {server && (
        <span className="inline-flex items-center gap-1.5">
          <Sparkles aria-hidden className={cn('size-3', server.configured ? 'text-ai' : 'text-muted-foreground')} />
          {server.configured ? `ИИ: ${server.model ?? 'модель'}${server.vision ? ', читает чертежи' : ''}` : 'ИИ не подключён'}
        </span>
      )}
    </div>
  );
}

export function EmptyScreen(): ReactElement {
  return (
    <div className="mx-auto w-full max-w-5xl pt-6 lg:pt-10">
      <NoDrawingsAlert />
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <Dropzone />
        <RequestCard />
      </div>
      <ServicesLine />
    </div>
  );
}
