// Телефон: «Скопировать для клиента» во всю ширину внизу экрана (всегда под рукой).
import type { ReactElement } from 'react';
import { CopyButton } from '@/components/quote/CopyButton.tsx';

export function MobileCopyBar(): ReactElement {
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:hidden">
      <CopyButton compact="full" className="w-full [&>button:first-child]:h-10 [&>button:last-child]:size-10" />
    </div>
  );
}
