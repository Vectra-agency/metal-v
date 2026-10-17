// Скрытые поля выбора файлов и папки. Монтируются один раз (в шапке); открываются из любого места:
// openFilePicker() — «Добавить», «Выбрать файлы», Ctrl+O; openFolderPicker() — «Папку…», «Выбрать папку».
import { useEffect, useRef, type ChangeEvent, type ReactElement } from 'react';
import { addFiles } from '@/store/pipelineActions.ts';

export const FILE_ACCEPT = '.dxf,.DXF,.pdf,.PDF,.txt,.TXT';

let filesInput: HTMLInputElement | null = null;
let folderInput: HTMLInputElement | null = null;

/** Диалог выбора файлов DXF, PDF, TXT */
export function openFilePicker(): void {
  filesInput?.click();
}

/** Диалог выбора папки заказа (имя папки станет названием заказа, если его нет) */
export function openFolderPicker(): void {
  folderInput?.click();
}

// у поля папки нет типа в React: атрибуты передаём как есть
const DIR_ATTRS = { webkitdirectory: '', directory: '' } as Record<string, string>;

export function FilePickers(): ReactElement {
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  useEffect(() => {
    filesInput = files.current;
    folderInput = folder.current;
    return () => {
      if (filesInput === files.current) filesInput = null;
      if (folderInput === folder.current) folderInput = null;
    };
  }, []);

  const onFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const list = [...(e.target.files ?? [])];
    e.target.value = '';
    if (list.length) void addFiles(list);
  };
  const onFolder = (e: ChangeEvent<HTMLInputElement>) => {
    const list = [...(e.target.files ?? [])];
    e.target.value = '';
    // «Заказ/чертежи/деталь.dxf» → название заказа «Заказ»
    const folderName = list[0]?.webkitRelativePath.split('/')[0] || undefined;
    if (list.length) void addFiles(list, { folderName });
  };
  return (
    <>
      <input ref={files} type="file" multiple hidden accept={FILE_ACCEPT} tabIndex={-1} aria-hidden onChange={onFiles} data-picker="files" />
      <input ref={folder} type="file" multiple hidden tabIndex={-1} aria-hidden onChange={onFolder} data-picker="folder" {...DIR_ATTRS} />
    </>
  );
}
