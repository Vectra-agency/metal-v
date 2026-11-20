// «Проверка DXF» в карточке позиции: ошибки (цена не считается, пока не «Считать как есть»), что поправить для цеха,
// к сведению, самое маленькое отверстие и самая узкая перемычка против толщины, и где это на контуре (кружки).
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { CircleCheck, Info, OctagonAlert, TriangleAlert } from '@/components/common/icons.ts';
import { PartPreview, type PreviewMark } from '@/components/common/PartPreview.tsx';
import type { DxfIssue } from '@/core/dxfCheck.ts';
import { n1, NBSP } from '@/format.ts';
import { cn } from '@/lib/utils.ts';
import type { OrderPosition } from '@/order.ts';
import { acceptDxf } from '@/store/actions.ts';

function IssueList({ items, tone }: { items: DxfIssue[]; tone: 'error' | 'warn' | 'info' }): ReactElement {
  const Icon = tone === 'error' ? OctagonAlert : tone === 'warn' ? TriangleAlert : Info;
  return (
    <ul className="space-y-1">
      {items.map((x, i) => (
        <li key={i} className="flex items-start gap-2">
          <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', tone === 'error' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-muted-foreground')} />
          <span className={tone === 'info' ? 'text-muted-foreground' : undefined}>{x.text}</span>
        </li>
      ))}
    </ul>
  );
}

export function DxfCheckSection({ base, pos }: { base: OrderPosition; pos: OrderPosition }): ReactElement | null {
  const c = base.dxfCheck;
  if (!c) return null; // PDF, деталь без чертежа или DXF, загруженный до проверки
  const errors = c.issues.filter((x) => x.level === 'error');
  const warns = c.issues.filter((x) => x.level === 'warn');
  const infos = c.issues.filter((x) => x.level === 'info');
  const marks: PreviewMark[] = [...errors, ...warns].flatMap((x) => (x.at ?? []).map((at) => ({ at, level: x.level })));
  const t = pos.thickness;
  const holeThin = !!c.minHole && c.minHole.d < t - 1e-6;
  const bridgeThin = !!c.minBridge && c.minBridge.d < t - 1e-6;
  if (holeThin && c.minHole) marks.push({ at: c.minHole.at, level: 'warn' });
  if (bridgeThin && c.minBridge) marks.push({ at: c.minBridge.at, level: 'warn' });
  const clean = !errors.length && !warns.length;

  return (
    <section aria-labelledby="dxf-h" data-sheet-focus="dxf" className="space-y-3">
      <h3 id="dxf-h" className="text-sm font-semibold">
        Проверка DXF
      </h3>

      {errors.length > 0 && (
        <div className={cn('space-y-2 rounded-md border p-3 text-sm', base.dxfAccepted ? 'border-warn/40 bg-warn-soft' : 'border-danger/40 bg-danger-soft')}>
          <p className="font-medium">
            {base.dxfAccepted ? 'Файл с ошибкой — посчитан как есть, проверьте цену' : 'Файл с ошибкой — цена позиции не считается'}
          </p>
          <IssueList items={errors} tone="error" />
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {base.dxfAccepted ? (
              <Button size="sm" variant="outline" onClick={() => acceptDxf(base.id, false)}>
                Снова не считать
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => acceptDxf(base.id)}>
                Считать как есть
              </Button>
            )}
            <span className="text-xs text-muted-foreground">Лучше попросить у клиента исправленный файл: цех его тоже не примет.</span>
          </div>
        </div>
      )}

      {warns.length > 0 && (
        <div className="space-y-1.5 text-sm">
          <p className="text-xs font-medium text-muted-foreground">Цена считается, но для цеха файл стоит поправить</p>
          <IssueList items={warns} tone="warn" />
        </div>
      )}

      {clean && (
        <p className="flex items-start gap-2 text-sm">
          <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-ok" />
          Контур замкнут, без самопересечений, 3D, дублей и мусора — файл годится для станка.
        </p>
      )}

      {(c.minHole || c.minBridge) && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm">
          {c.minHole && (
            <div className="contents">
              <dt className="text-muted-foreground">Самое маленькое отверстие</dt>
              <dd className={cn('tabular-nums', holeThin && 'text-warn')}>
                {n1(c.minHole.d)}
                {NBSP}мм{holeThin ? ` — меньше толщины ${n1(t)}${NBSP}мм` : ''}
              </dd>
            </div>
          )}
          {c.minBridge && (
            <div className="contents">
              <dt className="text-muted-foreground">Самая узкая перемычка</dt>
              <dd className={cn('tabular-nums', bridgeThin && 'text-warn')}>
                {n1(c.minBridge.d)}
                {NBSP}мм{bridgeThin ? ` — уже толщины ${n1(t)}${NBSP}мм` : ''}
              </dd>
            </div>
          )}
        </dl>
      )}

      {marks.length > 0 && (
        <figure className="space-y-1.5">
          <PartPreview preview={base.preview} size="large" showIgnored marks={marks} />
          <figcaption className="text-xs text-muted-foreground">Кружки — где ошибки и замечания на контуре.</figcaption>
        </figure>
      )}

      {infos.length > 0 && (
        <div className="text-sm">
          <IssueList items={infos} tone="info" />
        </div>
      )}
    </section>
  );
}
