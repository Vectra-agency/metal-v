// Замечание уровня заказа (цены, заявка, раскрой) в боковой панели: заголовок, полный текст, цитаты, действия
// и переход на нужную вкладку. Решено (или исчезло) — «Замечание решено».
import type { ReactElement } from 'react';
import { SECTION_TITLE, type SectionId } from '@/attention.ts';
import { Button } from '@/components/ui/button.tsx';
import { StatusIcon } from '@/components/common/StatusIcon.tsx';
import { setTab } from '@/store/actions.ts';
import { useDerived } from '@/store/derived.tsx';
import { useStore } from '@/store/store.ts';
import type { TabId } from '@/store/types.ts';
import { AttentionItemView } from './AttentionItemView.tsx';

export interface AttentionItemPanelProps {
  itemId: string;
}

const TAB_OF: Partial<Record<SectionId, { tab: TabId; label: string }>> = {
  prices: { tab: 'prices', label: 'Цены mc.ru' },
  nesting: { tab: 'metal', label: 'Металл и раскрой' },
  request: { tab: 'positions', label: 'Позиции' },
};

export function AttentionItemPanel({ itemId }: AttentionItemPanelProps): ReactElement {
  const { attention } = useDerived();
  const triage = useStore((s) => s.ui.triage);
  const item = attention.items.find((i) => i.id === itemId);
  if (!item || item.closed) {
    return (
      <div className="space-y-1 px-5 py-4">
        <StatusIcon kind="ok" label="Замечание решено" className="text-sm font-medium" />
        <p className="text-sm text-muted-foreground">Можно перейти к следующему или закрыть панель.</p>
      </div>
    );
  }
  const link = TAB_OF[item.section];
  return (
    <div className="space-y-3 px-5 py-4">
      <div className="text-xs font-medium text-muted-foreground">{SECTION_TITLE[item.section]}</div>
      <AttentionItemView item={item} dense={false} current={!!triage && triage.ids[triage.index] === item.id} />
      {link && (
        <Button variant="link" size="sm" className="h-auto px-0" onClick={() => setTab(link.tab)}>
          Открыть вкладку «{link.label}»
        </Button>
      )}
    </div>
  );
}
