// Только для разработки: синтетический анализ ИИ без вызова модели (ui-spec §5.6).
//   window.__metalcalcDev.fakeAi('apply')   — применить как обычный результат (с переносом прежних решений)
//   window.__metalcalcDev.fakeAi('pending') — как поздний результат: баннер «Анализ ИИ готов…»
// Все статусы (проблема, проверить, в порядке) и все виды предложений; цитаты — настоящие фрагменты текста
// чертежей плюс одна выдуманная (проверка отметок ✓ / ?). Подключается в main.tsx только в DEV.
import type { AiAnalysis, AiPositionReview, AiSuggestion } from '../core/ai.ts';
import { getMaterial, MATERIALS } from '../core/materials.ts';
import type { OrderResult, Settings } from '../core/pricing.ts';
import type { Order, OrderPosition } from '../order.ts';

/** Осмысленная строка текста чертежа (не короче 12 символов), обрезанная по слову до ~48 символов */
function realQuote(p: OrderPosition): string | null {
  const line = (p.drawingText ?? '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .find((l) => l.length >= 12 && /[А-Яа-яЁё]{4}/.test(l) && !/^Текст чертежа тот же/.test(l));
  if (!line) return null;
  if (line.length <= 48) return line;
  const cut = line.lastIndexOf(' ', 48);
  return line.slice(0, cut > 20 ? cut : 48);
}

const otherMaterial = (id: string) => (id === '08ps' ? 'st3' : '08ps');
const nextThickness = (p: OrderPosition) => getMaterial(p.materialId).thicknesses.find((t) => t > p.thickness) ?? p.thickness + 1;

/** Анализ для текущего заказа: тот же набор полей, что отдаёт сервер */
export function buildFakeAnalysis(order: Order, res: OrderResult, settings: Settings): AiAnalysis {
  const ps = order.positions.filter((p) => !p.disabled).slice(0, 150);
  const reviews: AiPositionReview[] = [];
  const sug = (p: OrderPosition, n: number, s: Omit<AiSuggestion, 'id'>): AiSuggestion => ({ id: `${p.id}#${n}`, ...s });
  const [a, b, c, ...rest] = ps;
  if (a) {
    const q = realQuote(a);
    reviews.push({
      id: a.id,
      status: 'problem',
      comment: `Количество в заявке больше, чем в файле: «${a.name} — ${a.qty + 4} шт».${q ? ` На чертеже: «${q}».` : ''} Также указано «Покрытие порошковое RAL 9999 глянец» — проверьте по чертежу.`,
      operations: ['лазерная резка', 'покраска'],
      suggestions: [
        sug(a, 1, { kind: 'qty', value: a.qty + 4, reason: `заявка: «${a.name} — ${a.qty + 4} шт»` }),
        sug(a, 2, {
          kind: 'material',
          materialId: otherMaterial(a.materialId),
          reason: `В штампе «Ст3 ГОСТ 19904» — это холоднокатаный лист, по нашим материалам ${getMaterial(otherMaterial(a.materialId)).short}.`,
        }),
      ],
    });
  }
  if (b) {
    const q = realQuote(b);
    const rate = settings.extraRates[0];
    const area = (b.geom.netArea / 1e6) * 2;
    const extra = rate ? Math.round(area * rate.price * 100) / 100 : 0;
    const suggestions: AiSuggestion[] = [
      sug(b, 1, { kind: 'bends', value: Math.max(b.bends, 0) + 2, reason: `На чертеже две линии гиба${q ? `: «${q}»` : ''}.` }),
    ];
    if (rate)
      suggestions.push(
        sug(b, 2, {
          kind: 'extra',
          label: rate.label,
          perPiece: extra,
          reason: `${rate.label}: 2 стороны × ${area.toFixed(3).replace('.', ',')} м² × ${rate.price} ₽/${rate.unit}.`,
        }),
      );
    // количество из заявки: при угаданном количестве применится само (значок «✦ ИИ», «Вернуть 1 шт»)
    suggestions.push(sug(b, suggestions.length + 1, { kind: 'qty', value: b.qty + 4, reason: `заявка: «${b.name} — ${b.qty + 4} шт»` }));
    reviews.push({
      id: b.id,
      status: 'check',
      comment: `Проверьте число гибов${q ? ` — на чертеже «${q}»` : ''}. Остальное по расчёту.`,
      operations: ['лазерная резка', 'гибка 2 гиба'],
      suggestions,
    });
  }
  if (c) {
    reviews.push({
      id: c.id,
      status: 'ok',
      comment: '',
      operations: ['лазерная резка'],
      suggestions: [sug(c, 1, { kind: 'thickness', value: nextThickness(c), reason: `В штампе указана толщина «s${nextThickness(c)}».` })],
    });
  }
  // одинаковое предложение количества для двух позиций с одинаковым количеством — объединённая строка «— 2 поз.»
  const pair = rest.find((p, i) => rest.slice(i + 1).some((x) => x.qty === p.qty));
  if (pair) {
    const twins = rest.filter((x) => x.qty === pair.qty).slice(0, 2);
    for (const p of twins)
      reviews.push({
        id: p.id,
        status: 'ok',
        comment: '',
        operations: [],
        suggestions: [sug(p, 1, { kind: 'qty', value: p.qty + 4, reason: `заявка: «${p.name} — ${p.qty + 4} шт»` })],
      });
  }
  const last = ps.length >= 4 ? ps[ps.length - 1] : null;
  if (last && !reviews.some((r) => r.id === last.id)) {
    reviews.push({
      id: last.id,
      status: 'check',
      comment: `В заявке нет «${last.name}» — похоже, это исполнение, которое не заказано.`,
      operations: [],
      suggestions: [sug(last, 1, { kind: 'disable', reason: `в заявке нет «${last.name}»` })],
    });
  }
  const total = Math.round(res.totals.total);
  return {
    summary: `Тестовый анализ (dev-fake) по ${ps.length} позициям, итог до проверки ${total} ₽. ${a ? `По ${a.name} количество в заявке больше; позиция ${a.id} — с ошибкой.` : ''} Материалы из справочника: ${MATERIALS.length}.`,
    confidence: 'medium',
    positions: reviews,
    questions: [
      a ? `Подтвердите количество ${a.name}: в заявке ${a.qty + 4} шт, в файле ${a.qty} шт.` : 'Подтвердите количество.',
      'Нужна ли покраска всех деталей, и в какой цвет?',
    ],
    risks: ['Цены металла — оценка по ближайшей толщине: итог может измениться.'],
    recommendations: ['Объединить детали одной толщины в один раскрой — дешевле металл.'],
    model: 'dev-fake',
    createdAt: new Date().toISOString(),
    durationMs: 1234,
    usage: { promptTokens: 12345, completionTokens: 678, costRub: 0.35 },
    fallback: false,
  };
}

/** Синтетический анализ для текущего заказа (store подключается лениво — модуль можно импортировать и в Node) */
export async function fakeAi(mode: 'apply' | 'pending' = 'apply'): Promise<void> {
  const [{ getState, patchAi, setOrder }, { getDerived }, { aiStateFrom }, { buildAiContext, contextHash }] = await Promise.all([
    import('../store/store.ts'),
    import('../store/derived.tsx'),
    import('./apply.ts'),
    import('./context.ts'),
  ]);
  const s = getState();
  if (!s.order.positions.length) {
    console.warn('fakeAi: в заказе нет позиций');
    return;
  }
  const d = getDerived();
  const ctx = buildAiContext(s.order, d.baseRes, s.prices.book, s.settings);
  const hash = contextHash(ctx);
  const analysis = buildFakeAnalysis(s.order, d.baseRes, s.settings);
  const scope = ctx.positions.map((p) => p.id);
  const at = Date.now();
  if (mode === 'pending') {
    patchAi({ pending: { analysis, contextHash: hash, scope, ctx, receivedAt: at }, outcome: { kind: 'done', at } });
    return;
  }
  setOrder((o) => ({ ...o, ai: aiStateFrom(analysis, o.positions, hash, { prev: o.ai }), aiScope: scope }));
  patchAi({ lastContext: ctx, lastImages: 0, outcome: { kind: 'done', at }, pending: null });
}

if (typeof window !== 'undefined') (window as unknown as { __metalcalcDev: { fakeAi: typeof fakeAi } }).__metalcalcDev = { fakeAi };
