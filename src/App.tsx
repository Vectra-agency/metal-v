// Каркас приложения: экран (пустой / обработка / результат) по состоянию, точки монтирования панелей и диалогов
// (каждый ничего не рисует, пока закрыт) и корень печати вне .screen-only.
import type { ReactElement } from 'react';
import { DerivedProvider } from '@/store/derived.tsx';
import { selectView, useStore } from '@/store/store.ts';
import { ResultScreen } from '@/components/ResultScreen.tsx';
import { PositionSheet } from '@/components/position/PositionSheet.tsx';
import { PdfReviewDialog } from '@/components/position/PdfReviewDialog.tsx';
import { PrintRoot } from '@/components/print/PrintRoot.tsx';
import { CopyGuardDialog } from '@/components/quote/CopyGuardDialog.tsx';
import { SettingsSheet } from '@/components/settings/SettingsSheet.tsx';
import { DropOverlay } from '@/components/shell/DropOverlay.tsx';
import { EmptyScreen } from '@/components/shell/EmptyScreen.tsx';
import { GlobalEffects } from '@/components/shell/GlobalEffects.tsx';
import { Header } from '@/components/shell/Header.tsx';
import { ManualDialog } from '@/components/shell/ManualDialog.tsx';
import { ProcessingScreen } from '@/components/shell/ProcessingScreen.tsx';
import { RequestSheet } from '@/components/shell/RequestSheet.tsx';
import { ShortcutsDialog } from '@/components/shell/ShortcutsDialog.tsx';

export function App(): ReactElement {
  const view = useStore(selectView);
  return (
    <DerivedProvider>
      <GlobalEffects />
      <div className="screen-only min-h-dvh">
        <Header />
        <main className="mx-auto flex w-full max-w-[1920px] flex-col gap-4 px-4 pt-4 pb-24 lg:px-6">
          {view === 'processing' ? <ProcessingScreen /> : view === 'empty' ? <EmptyScreen /> : <ResultScreen />}
        </main>
        <DropOverlay />
        <PositionSheet />
        <RequestSheet />
        <SettingsSheet />
        <ManualDialog />
        <PdfReviewDialog />
        <CopyGuardDialog />
        <ShortcutsDialog />
      </div>
      <PrintRoot />
    </DerivedProvider>
  );
}
