// Помощники для клавиатуры: поле ввода под фокусом и переход Enter → то же поле в следующей строке.

/** Цель события — поле ввода (Esc и стрелки там работают для поля, а не для панели).
 *  Открытые списки (Select, Popover) сами забирают Esc как верхний слой Radix — их здесь не учитываем. */
export function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  if (el.isContentEditable) return true;
  return !!el.closest('input:not([type=checkbox]):not([type=radio]):not([type=button]), textarea, select');
}

/** Фокус на поле с data-nav-col=col и data-nav-row=row (если есть); true — нашлось */
export function focusNav(col: string, row: number): boolean {
  const el = document.querySelector<HTMLElement>(`[data-nav-col="${CSS.escape(col)}"][data-nav-row="${row}"]`);
  if (!el) return false;
  el.focus();
  if (el instanceof HTMLInputElement) el.select();
  return true;
}
