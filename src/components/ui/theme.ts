// Тема оформления (замена next-themes): тёмная тема = класс .dark на <html> — по нему
// переключаются переменные в src/index.css и вариант dark: в Tailwind.
// Выбор хранится в localStorage; до загрузки приложения тему ставит inline-скрипт
// в index.html (тот же ключ и та же логика) — без вспышки светлой темы.
import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_KEY = 'metalcalc.theme';

const listeners = new Set<() => void>();
const osDark = () => window.matchMedia('(prefers-color-scheme: dark)');

function stored(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

let theme: Theme = typeof window === 'undefined' ? 'system' : stored();

function paint(dark: boolean): void {
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
}

function apply(): void {
  paint(theme === 'dark' || (theme === 'system' && osDark().matches));
  for (const l of listeners) l();
}

export function getTheme(): Theme {
  return theme;
}

/** 'system' — как в ОС (по умолчанию) */
export function setTheme(next: Theme): void {
  theme = next;
  try {
    if (next === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, next);
  } catch {
    // приватный режим: тема только до перезагрузки
  }
  apply();
}

/** Один раз при старте: следить за темой ОС и другими вкладками; печать всегда в светлой теме */
export function initTheme(): void {
  apply();
  osDark().addEventListener('change', () => {
    if (theme === 'system') apply();
  });
  window.addEventListener('storage', (e) => {
    if (e.key !== THEME_KEY) return;
    theme = stored();
    apply();
  });
  window.addEventListener('beforeprint', () => paint(false));
  window.addEventListener('afterprint', apply);
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};
const resolved = (): ResolvedTheme => (document.documentElement.classList.contains('dark') ? 'dark' : 'light');

/** theme — выбор пользователя, resolvedTheme — что показано сейчас */
export function useTheme(): { theme: Theme; resolvedTheme: ResolvedTheme; setTheme: (t: Theme) => void } {
  const t = useSyncExternalStore(subscribe, getTheme);
  const resolvedTheme = useSyncExternalStore(subscribe, resolved);
  return { theme: t, resolvedTheme, setTheme };
}
