// Печать: КП для клиента (по умолчанию — Ctrl+P или меню браузера на любой вкладке) или внутренний расчёт
// (только пока ui.printMode === 'internal'). На экране корень печати скрыт (print.css).
import { useEffect, type ReactElement } from 'react';
import { QuoteDocument } from '@/components/quote/QuoteDocument.tsx';
import { setPrintPage } from '@/store/quoteActions.ts';
import { useStore } from '@/store/store.ts';
import { InternalPrint } from './InternalPrint.tsx';

export function PrintRoot(): ReactElement {
  const mode = useStore((s) => s.ui.printMode);
  const has = useStore((s) => s.order.positions.length > 0);
  // по умолчанию печатается КП: html[data-print='client'] и А4 книжный
  useEffect(() => setPrintPage('client'), []);
  return (
    <div className="print-root">
      <div className="print-client">{has && <QuoteDocument variant="print" />}</div>
      {mode === 'internal' && (
        <div className="print-internal">
          <InternalPrint />
        </div>
      )}
    </div>
  );
}
