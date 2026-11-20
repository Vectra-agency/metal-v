// Каркас приложения: экран (пустой / обработка / результат) по состоянию, точки монтирования панелей и диалогов
// (каждый ничего не рисует, пока закрыт) и корень печати вне .screen-only. Доска задач (/tasks) — отдельный экран;
// калькулятор под ней остаётся смонтированным (скрыт): заказ, открытые поля и анализ ИИ не сбрасываются.
import { useEffect, type ReactElement } from 'react';
import { DerivedProvider } from '@/store/derived.tsx';
import { patchUi, selectView, useStore } from '@/store/store.ts';
import { ResultScreen } from '@/components/ResultScreen.tsx';
import { PositionSheet } from '@/components/position/PositionSheet.tsx';
import { PdfReviewDialog } from '@/components/position/PdfReviewDialog.tsx';
import { PrintRoot } from '@/components/print/PrintRoot.tsx';
import { CopyGuardDialog } from '@/components/quote/CopyGuardDialog.tsx';
import { HistorySheet } from '@/components/history/HistorySheet.tsx';
import { InvoiceDialog } from '@/components/history/InvoiceDialog.tsx';
import { SettingsSheet } from '@/components/settings/SettingsSheet.tsx';
import { DropOverlay } from '@/components/shell/DropOverlay.tsx';
import { EmptyScreen } from '@/components/shell/EmptyScreen.tsx';
import { GlobalEffects } from '@/components/shell/GlobalEffects.tsx';
import { Header } from '@/components/shell/Header.tsx';
import { ManualDialog } from '@/components/shell/ManualDialog.tsx';
import { ProcessingScreen } from '@/components/shell/ProcessingScreen.tsx';
import { RequestSheet } from '@/components/shell/RequestSheet.tsx';
import { ShortcutsDialog } from '@/components/shell/ShortcutsDialog.tsx';
import { TasksHeader } from '@/components/tasks/TasksHeader.tsx';
import { TasksScreen } from '@/components/tasks/TasksScreen.tsx';
import { useTasks } from '@/tasks/store.ts';

export function App(): ReactElement {
  const view = useStore(selectView);
  const tasks = useTasks((s) => s.screen === 'tasks');
  // на доску ушли кнопкой «назад» при открытой панели или окне калькулятора — они живут в портале и остались бы сверху
  useEffect(() => {
    if (tasks) patchUi({ sheet: null, dialog: null, triage: null });
  }, [tasks]);
  return (
    <DerivedProvider>
      <GlobalEffects />
      {tasks && (
        <div className="screen-only flex h-dvh flex-col">
          <TasksHeader />
          <TasksScreen />
        </div>
      )}
      <div className="screen-only min-h-dvh" hidden={tasks}>
        <Header />
        <main className="mx-auto flex w-full max-w-[1920px] flex-col gap-4 px-4 pt-4 pb-24 lg:px-6">
          {view === 'processing' ? <ProcessingScreen /> : view === 'empty' ? <EmptyScreen /> : <ResultScreen />}
        </main>
        {!tasks && <DropOverlay />}
        <PositionSheet />
        <RequestSheet />
        <SettingsSheet />
        <HistorySheet />
        <ManualDialog />
        <PdfReviewDialog />
        <CopyGuardDialog />
        <InvoiceDialog />
        <ShortcutsDialog />
      </div>
      <PrintRoot />
    </DerivedProvider>
  );
}
