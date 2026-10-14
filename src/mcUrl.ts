/** Ссылка на выборку mc.ru по разделу и толщине */
export const mcUrl = (category: string, t: number, region = 'speterburg') =>
  `https://mc.ru/region/${region}/metalloprokat/${category}/r1/${String(t).replace(',', '.')}`;
