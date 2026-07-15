import { Baseline, Superscript } from 'lucide-react';

interface EquationToolbarProps {
  textareaId: string;
  value: string;
  onChange: (value: string) => void;
}

const symbols = ['e⁻', '²⁺', '⁻', '₂', '→', '⇌', 'H⁺', 'OH⁻', 'Zn²⁺', 'Cu²⁺', 'SO₄²⁻'];

export function EquationToolbar({ textareaId, value, onChange }: EquationToolbarProps) {
  const insert = (symbol: string) => {
    const textarea = document.getElementById(textareaId) as HTMLTextAreaElement | null;
    const start = textarea?.selectionStart ?? value.length;
    const end = textarea?.selectionEnd ?? value.length;
    onChange(`${value.slice(0, start)}${symbol}${value.slice(end)}`);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(start + symbol.length, start + symbol.length);
    });
  };

  return (
    <div className="equation-toolbar" aria-label="方程式符号条">
      <span aria-hidden="true"><Superscript /></span>
      {symbols.map((symbol) => (
        <button key={symbol} onClick={() => insert(symbol)} type="button" aria-label={`插入 ${symbol}`}>
          {symbol}
        </button>
      ))}
      <span aria-hidden="true"><Baseline /></span>
    </div>
  );
}
