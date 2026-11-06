// Экран результата: итог заказа, анализ ИИ и вкладки (позиции, металл и раскрой, цены mc.ru, для клиента).
// Полоса вкладок липкая (под шапкой и полосой итогов); на вкладке «Позиции» во второй строке — поиск и фильтры.
import type { ReactElement } from 'react';
import { Badge } from '@/components/ui/badge.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx';
import { TriangleAlert } from '@/components/common/icons.ts';
import { AiCard } from '@/components/ai/AiCard.tsx';
import { MetalTab } from '@/components/metal/MetalTab.tsx';
import { KpiBand } from '@/components/money/KpiBand.tsx';
import { QtyMissingBanner } from '@/components/money/QtyMissingBanner.tsx';
import { PositionsTab } from '@/components/positions/PositionsTab.tsx';
import { PositionsToolbar } from '@/components/positions/PositionsToolbar.tsx';
import { PricesTab } from '@/components/prices/PricesTab.tsx';
import { QuoteTab } from '@/components/quote/QuoteTab.tsx';
import { setTab } from '@/store/actions.ts';
import { useDerived } from '@/store/derived.tsx';
import { useStore } from '@/store/store.ts';
import type { TabId } from '@/store/types.ts';

interface TabDef {
  id: TabId;
  label: string;
  count?: number;
  warn?: string; // есть замечания — значок и пояснение для диктора
}

export function ResultScreen(): ReactElement {
  const tab = useStore((s) => s.ui.tab);
  const positions = useStore((s) => s.order.positions.length);
  const d = useDerived();
  const priceItems = d.attention.open.filter((i) => i.section === 'prices').length;
  const tabs: TabDef[] = [
    { id: 'positions', label: 'Позиции', count: positions },
    { id: 'metal', label: 'Металл и раскрой', count: d.res.groups.length },
    { id: 'prices', label: 'Цены mc.ru', warn: priceItems ? 'есть замечания по ценам' : undefined },
    { id: 'quote', label: 'Для клиента' },
  ];
  return (
    <>
      <QtyMissingBanner />
      <KpiBand />
      <AiCard />
      <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)} className="gap-0">
        <div className="sticky top-[calc(var(--header-h)+var(--strip-h))] z-20 -mx-4 bg-background/95 px-4 backdrop-blur lg:-mx-6 lg:px-6">
          <div className="flex h-11 items-end border-b max-sm:hidden">
            <TabsList variant="line" aria-label="Разделы расчёта" className="gap-2">
              {tabs.map((t) => (
                <TabsTrigger key={t.id} value={t.id} className="px-2.5">
                  {t.label}
                  {t.count != null && (
                    <Badge variant="secondary" className="h-5 min-w-5 px-1.5 tabular-nums">
                      {t.count}
                    </Badge>
                  )}
                  {t.warn && (
                    <>
                      <TriangleAlert aria-hidden className="size-3.5 text-warn" />
                      <span className="sr-only">{t.warn}</span>
                    </>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          {/* телефон: вкладки — списком */}
          <div className="flex h-11 items-center border-b sm:hidden">
            <Select value={tab} onValueChange={(v) => setTab(v as TabId)}>
              <SelectTrigger aria-label="Раздел расчёта" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {tabs.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.label}
                    {t.count != null ? ` · ${t.count}` : ''}
                    {t.warn ? ' · ⚠' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {tab === 'positions' && (
            <div className="flex h-10 items-center gap-2 border-b">
              <PositionsToolbar />
            </div>
          )}
        </div>
        {/* таблица позиций не размонтируется при смене вкладки: прокрутка, выделение и фокус сохраняются */}
        <TabsContent value="positions" forceMount className="pt-4 data-[state=inactive]:hidden">
          <PositionsTab />
        </TabsContent>
        <TabsContent value="metal" className="pt-4">
          <MetalTab />
        </TabsContent>
        <TabsContent value="prices" className="pt-4">
          <PricesTab />
        </TabsContent>
        <TabsContent value="quote" className="pt-4">
          <QuoteTab />
        </TabsContent>
      </Tabs>
    </>
  );
}
