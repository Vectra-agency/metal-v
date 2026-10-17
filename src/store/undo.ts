// Отмена вместо подтверждений: действие выполняется сразу, в уведомлении — «Вернуть» (15 с).
import { toast } from 'sonner';

// ---------- эпоха заказа ----------
// «Новый заказ» начинает новую эпоху, его «Вернуть» возвращает прежнюю. Отмена правки заказа (orderScoped)
// срабатывает только в той эпохе, в которой сделана правка: «Вернуть» старого удаления не вставит позиции в новый заказ.

let epoch = 0;
let epochSeq = 0;

export const orderEpoch = (): number => epoch;

/** Новая эпоха («Новый заказ»); возвращает прежнюю — для его «Вернуть» */
export function newOrderEpoch(): number {
  const prev = epoch;
  epoch = ++epochSeq;
  return prev;
}

/** Вернуть эпоху (заказ возвращён «Вернуть») */
export function restoreOrderEpoch(e: number): void {
  epoch = e;
}

export function undoToast(o: {
  message: string;
  undo: () => void;
  onExpire?: () => void; // уведомление закрылось без «Вернуть» — действие окончательно (один раз)
  actionLabel?: string; // «Вернуть»
  duration?: number; // 15 000 мс
  orderScoped?: boolean; // правка заказа: после «Новый заказ» «Вернуть» не действует (пока заказ не вернули)
}): void {
  const at = epoch;
  let done = false;
  const expire = () => {
    if (done) return;
    done = true;
    o.onExpire?.();
  };
  toast(o.message, {
    duration: o.duration ?? 15_000,
    action: {
      label: o.actionLabel ?? 'Вернуть',
      onClick: (e) => {
        if (done) return;
        if (o.orderScoped && epoch !== at) {
          // заказ уже другой: уведомление остаётся — после «Вернуть» прежнего заказа отмена снова сработает
          e.preventDefault();
          toast('Заказ уже другой — вернуть нельзя', { id: 'undo-other-order' });
          return;
        }
        done = true;
        o.undo();
      },
    },
    onAutoClose: expire,
    onDismiss: expire,
  });
}
