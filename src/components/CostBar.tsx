export const CATS = [
  { key: 'material', label: 'Металл', color: 'var(--c-metal)' },
  { key: 'cut', label: 'Резка', color: 'var(--c-cut)' },
  { key: 'bend', label: 'Гибка', color: 'var(--c-bend)' },
  { key: 'extras', label: 'Доп. работы', color: 'var(--c-extra)' },
  { key: 'delivery', label: 'Доставка', color: 'var(--c-deliv)' },
] as const;

export type CatKey = (typeof CATS)[number]['key'];

/** Горизонтальная полоса долей стоимости (сегменты с зазором 2px) */
export function CostBar({ parts, height = 6, title }: { parts: Partial<Record<CatKey, number>>; height?: number; title?: string }) {
  const total = CATS.reduce((a, c) => a + Math.max(0, parts[c.key] ?? 0), 0);
  if (total <= 0) return <div className="costbar costbar-empty" style={{ height }} />;
  return (
    <div className="costbar" style={{ height }} title={title}>
      {CATS.map((c) => {
        const v = Math.max(0, parts[c.key] ?? 0);
        if (!v) return null;
        return <span key={c.key} style={{ flexGrow: v / total, background: c.color }} />;
      })}
    </div>
  );
}
