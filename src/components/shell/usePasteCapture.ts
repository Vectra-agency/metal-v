// Ctrl/⌘+V на пустом экране и экране обработки (ui-spec §2.18): текст — в «Заявку клиента» (дописывается),
// файлы из буфера — в заказ. На экране результата и в полях ввода — обычная вставка.
import { useEffect } from 'react';
import { isEditable } from '@/components/common/dom.ts';
import { addFiles, setRequest } from '@/store/pipelineActions.ts';
import { getState, selectView } from '@/store/store.ts';

/** Фокус в поле заявки (на пустом экране или экране обработки), курсор — в конец */
export function focusRequestInput(): void {
  requestAnimationFrame(() => {
    const el = document.getElementById('request-input') as HTMLTextAreaElement | null;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
    el.scrollTop = el.scrollHeight;
  });
}

export function usePasteCapture(): void {
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const s = getState();
      if (selectView(s) === 'result' || isEditable(e.target) || s.ui.dialog || s.ui.sheet) return;
      const dt = e.clipboardData;
      if (!dt) return;
      const files = [...dt.files];
      if (files.length) {
        e.preventDefault();
        void addFiles(files);
        return;
      }
      const text = dt.getData('text/plain');
      if (!text.trim()) return;
      e.preventDefault();
      const cur = s.order.request ?? '';
      setRequest(cur ? `${cur}\n${text}` : text);
      focusRequestInput();
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);
}
