// Горячие клавиши окна (ui-spec §2.18): Ctrl/⌘+O — файлы, Ctrl/⌘+P — печать КП, «/» — поиск позиций, «?» — список клавиш.
// Клавиши таблицы и карточки позиции — у них самих. Буквы сверяем по коду клавиши: в русской раскладке
// Ctrl+O приходит как «щ», а «/» — как «.».
import { useEffect } from 'react';
import { isEditable } from '@/components/common/dom.ts';
import { openDialog, setTab } from '@/store/actions.ts';
import { printClient } from '@/store/quoteActions.ts';
import { getState, selectView } from '@/store/store.ts';
import { openFilePicker } from './FilePickers.tsx';

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
/** Модификатор в подписях: «⌘» на macOS, иначе «Ctrl» */
export const MOD = IS_MAC ? '⌘' : 'Ctrl';

/** Поиск по позициям (поле в панели вкладки «Позиции») */
export function focusPositionsSearch(): void {
  setTimeout(() => {
    const el = document.querySelector<HTMLInputElement>('#positions-search, [data-positions-search], main input[type="search"]');
    el?.focus();
    el?.select();
  }, 30);
}

/** Открыта модальная панель или диалог — одиночные клавиши не перехватываем */
const modalOpen = (): boolean => {
  const { sheet, dialog } = getState().ui;
  return !!dialog || sheet?.kind === 'request' || sheet?.kind === 'settings';
};

export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      if (mod && !e.altKey && !e.shiftKey && (e.code === 'KeyO' || e.key.toLowerCase() === 'o')) {
        e.preventDefault(); // и при удержании: браузерное «Открыть файл» не нужно
        if (!e.repeat) openFilePicker();
        return;
      }
      if (mod && !e.altKey && !e.shiftKey && (e.code === 'KeyP' || e.key.toLowerCase() === 'p')) {
        e.preventDefault();
        if (!e.repeat) printClient();
        return;
      }
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target) || modalOpen()) return;
      if (e.key === '?' || (e.code === 'Slash' && e.shiftKey)) {
        e.preventDefault();
        openDialog({ kind: 'shortcuts' });
        return;
      }
      if (e.key === '/' || (e.code === 'Slash' && !e.shiftKey)) {
        if (selectView(getState()) !== 'result') return;
        e.preventDefault();
        setTab('positions');
        focusPositionsSearch();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
