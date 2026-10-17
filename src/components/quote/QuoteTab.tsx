// Вкладка «Для клиента»: КП как будет напечатано (белый лист и в тёмной теме) + панель отправки и «Перед отправкой».
import type { ReactElement } from 'react';
import { QuoteDocument } from './QuoteDocument.tsx';
import { SendPanel } from './SendPanel.tsx';

export function QuoteTab(): ReactElement {
  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-2">
        <p className="mx-auto w-full max-w-[794px] text-xs text-muted-foreground">КП — как будет напечатано</p>
        <div className="mx-auto w-full max-w-[794px] overflow-x-auto rounded-sm bg-white p-5 text-neutral-900 shadow-sm ring-1 ring-border sm:p-10">
          <QuoteDocument variant="screen" />
        </div>
      </div>
      {/* липнет под полосой вкладок: шапка + полоса итогов + вкладки (44 px) + 4 px; верх — вровень с листом КП (под подписью) */}
      <div className="max-xl:order-first xl:sticky xl:top-[calc(var(--header-h)+var(--strip-h)+3rem)] xl:mt-6">
        <SendPanel />
      </div>
    </div>
  );
}
