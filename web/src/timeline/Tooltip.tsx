export interface TooltipModel {
  title: string;
  color?: string;
  lines: [string, string][];
}

interface TooltipProps {
  model: TooltipModel;
  x: number;
  y: number;
  bounds: { width: number; height: number };
}

const TOOLTIP_WIDTH = 300;

export function Tooltip({ model, x, y, bounds }: TooltipProps) {
  const left = x + TOOLTIP_WIDTH + 24 > bounds.width ? Math.max(0, x - TOOLTIP_WIDTH - 12) : x + 14;
  const top = Math.min(y + 14, Math.max(0, bounds.height - 40 - model.lines.length * 18));
  return (
    <div className="tooltip" style={{ left, top, width: TOOLTIP_WIDTH }} role="tooltip">
      <div className="tooltip-title">
        {model.color && <span className="swatch" style={{ background: model.color }} />}
        {model.title}
      </div>
      <dl>
        {model.lines.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
