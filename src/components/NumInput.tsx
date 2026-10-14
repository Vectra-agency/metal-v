import { useEffect, useState } from 'react';

interface Props {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  step?: number;
  className?: string;
  suffix?: string;
  title?: string;
  placeholder?: string;
  allowEmpty?: boolean;
  width?: number;
}

/** Числовое поле: принимает запятую, применяет по Enter/потере фокуса */
export function NumInput({ value, onChange, min = 0, className = '', suffix, title, placeholder, allowEmpty, width }: Props) {
  const [text, setText] = useState(fmt(value, allowEmpty));
  useEffect(() => setText(fmt(value, allowEmpty)), [value, allowEmpty]);
  const commit = () => {
    const t = text.trim().replace(/\s/g, '').replace(',', '.');
    if (t === '' && allowEmpty) {
      onChange(0);
      return;
    }
    const v = Number(t);
    if (Number.isFinite(v) && v >= min) {
      if (v !== value) onChange(v);
    } else setText(fmt(value, allowEmpty));
  };
  return (
    <span className={`num ${className}`} title={title}>
      <input
        inputMode="decimal"
        value={text}
        placeholder={placeholder}
        style={width ? { width } : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setText(fmt(value, allowEmpty));
            (e.target as HTMLInputElement).blur();
          }
        }}
        onFocus={(e) => e.target.select()}
      />
      {suffix && <span className="num-suffix">{suffix}</span>}
    </span>
  );
}

function fmt(v: number, allowEmpty?: boolean) {
  if (allowEmpty && !v) return '';
  return String(Math.round(v * 1000) / 1000).replace('.', ',');
}
