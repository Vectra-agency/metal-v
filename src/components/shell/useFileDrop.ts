// Перетаскивание файлов и папок в любое место окна: счётчик вложенных dragenter/dragleave (как в старом App),
// половина окна под курсором и сброс: левая — добавить к заказу, правая — новый заказ (если заказ не пуст).
import { useEffect, useState } from 'react';
import { filesFromDrop } from '@/order.ts';
import { addFiles } from '@/store/pipelineActions.ts';
import { getState } from '@/store/store.ts';

export type DropHalf = 'left' | 'right';

const isFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
const halfOf = (e: DragEvent): DropHalf => (e.clientX < window.innerWidth / 2 ? 'left' : 'right');

/** Две половины («Добавить» / «Новый заказ») — только для непустого заказа вне экрана обработки */
export const splitDrop = (): boolean => {
  const s = getState();
  return s.order.positions.length > 0 && !s.pipeline.processing;
};

export function useFileDrop(): { active: boolean; half: DropHalf } {
  const [active, setActive] = useState(false);
  const [half, setHalf] = useState<DropHalf>('left');
  useEffect(() => {
    let depth = 0;
    const reset = () => {
      depth = 0;
      setActive(false);
    };
    const enter = (e: DragEvent) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      depth++;
      setActive(true);
      setHalf(halfOf(e));
    };
    const leave = (e: DragEvent) => {
      if (!isFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setActive(false);
    };
    const over = (e: DragEvent) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setHalf(halfOf(e));
    };
    const drop = (e: DragEvent) => {
      if (!isFiles(e) || !e.dataTransfer) return;
      e.preventDefault();
      reset();
      const dt = e.dataTransfer;
      const mode = splitDrop() && halfOf(e) === 'right' ? 'new' : 'append';
      // записи папок доступны только во время события — читаем сразу
      const entry = dt.items[0]?.webkitGetAsEntry?.();
      const folderName = entry?.isDirectory ? entry.name : undefined;
      void filesFromDrop(dt).then((files) => addFiles(files, { mode, folderName }));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    window.addEventListener('dragend', reset);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
      window.removeEventListener('dragend', reset);
    };
  }, []);
  return { active, half };
}
