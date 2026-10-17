// «Что видел ИИ»: ровно те данные, что ушли модели (хранятся только в памяти до перезагрузки страницы):
// заявка, документы, тексты чертежей, ставки доп. операций, цены металла.
import type { ReactElement, ReactNode } from 'react';
import { toast } from 'sonner';
import { dateDay, dateShort, n0, n1, NBSP, plural } from '@/format.ts';
import { Button } from '@/components/ui/button.tsx';
import { Copy } from '@/components/common/icons.ts';
import { useStore } from '@/store/store.ts';

const SOURCE: Record<string, string> = { mc: 'mc.ru', estimate: 'оценка', manual: 'вручную' };

function Block({ title, count, children }: { title: string; count?: number; children: ReactNode }): ReactElement {
  return (
    <details className="group rounded-md border px-3 py-1.5 [&[open]]:pb-2">
      <summary className="focus-ring cursor-pointer rounded-sm text-xs font-medium text-muted-foreground select-none hover:text-foreground">
        {title}
        {count != null && <span className="tabular-nums"> ({count})</span>}
      </summary>
      <div className="mt-2 space-y-2">{children}</div>
    </details>
  );
}

const Pre = ({ children }: { children: string }) => (
  <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{children}</pre>
);

async function copyJson(v: unknown) {
  try {
    await navigator.clipboard.writeText(JSON.stringify(v, null, 2));
    toast.success('Данные анализа скопированы (JSON)');
  } catch {
    toast.error('Не удалось скопировать');
  }
}

export function AiContextView(): ReactElement {
  const ctx = useStore((s) => s.ai.lastContext);
  const images = useStore((s) => s.ai.lastImages);
  const hasAi = useStore((s) => !!s.order.ai);
  if (!ctx) {
    return (
      <p className="text-xs text-muted-foreground">
        {hasAi ? 'Что именно получил ИИ, хранится только до перезагрузки страницы. Чтобы посмотреть, обновите анализ ИИ.' : 'Анализ ИИ ещё не запускался.'}
      </p>
    );
  }
  const texts = ctx.positions.filter((p) => p.drawingText);
  const docs = ctx.documents;
  const n = ctx.positions.length;
  return (
    <div className="space-y-2 text-xs">
      <p className="text-muted-foreground">
        Отправлено {dateShort(ctx.createdAt)}: {n} {plural(n, 'позиция', 'позиции', 'позиций')}, {ctx.groups.length}{' '}
        {plural(ctx.groups.length, 'группа', 'группы', 'групп')} металла, {docs.length} {plural(docs.length, 'документ', 'документа', 'документов')}, заявка —{' '}
        {ctx.order.request ? `${n0(ctx.order.request.length)}${NBSP}симв.` : 'нет'}, изображений чертежей — {images}. Цены mc.ru от{' '}
        {dateDay(ctx.order.pricesUpdatedAt)}. Данные хранятся только до перезагрузки страницы.
      </p>
      <div className="grid gap-2">
        <Block title="Заявка клиента">
          {ctx.order.request ? <Pre>{ctx.order.request}</Pre> : <p className="text-muted-foreground">Заявку не вставляли.</p>}
        </Block>
        {docs.length > 0 && (
          <Block title="Документы" count={docs.length}>
            {docs.map((d) => (
              <div key={d.fileName}>
                <div className="mb-1 font-medium">{d.fileName}</div>
                <Pre>{d.text}</Pre>
              </div>
            ))}
          </Block>
        )}
        <Block title="Тексты чертежей" count={texts.length}>
          {texts.length ? (
            texts.map((p) => (
              <div key={p.id}>
                <div className="mb-1 font-medium">{p.name}</div>
                <Pre>{p.drawingText!}</Pre>
              </div>
            ))
          ) : (
            <p className="text-muted-foreground">На чертежах не найдено текста.</p>
          )}
        </Block>
        <Block title="Цены металла" count={ctx.groups.length}>
          <ul className="space-y-0.5 tabular-nums">
            {ctx.groups.map((g) => {
              const o = g.offers.find((x) => x.sheet === g.chosenSheet) ?? g.offers[0];
              return (
                <li key={g.key}>
                  {g.materialLabel} {n1(g.thickness)}
                  {NBSP}мм — лист {g.chosenSheet}
                  {o ? `, ${n1(o.pricePerKg)}${NBSP}₽/кг (${SOURCE[o.source] ?? o.source})` : ''}
                </li>
              );
            })}
          </ul>
        </Block>
        <Block title="Ставки доп. операций" count={ctx.rates.extraOps.length}>
          <ul className="space-y-0.5 tabular-nums">
            {ctx.rates.extraOps.map((r) => (
              <li key={r.label}>
                {r.label} — {n1(r.price)}
                {NBSP}₽/{r.unit}
              </li>
            ))}
          </ul>
        </Block>
      </div>
      <Button variant="ghost" size="xs" onClick={() => void copyJson(ctx)} className="text-muted-foreground">
        <Copy aria-hidden />
        Скопировать данные (JSON)
      </Button>
    </div>
  );
}
