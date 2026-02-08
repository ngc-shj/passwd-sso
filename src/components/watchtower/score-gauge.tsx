"use client";

interface ScoreGaugeProps {
  score: number; // 0-100
  size?: number;
}

function getScoreColor(score: number): string {
  if (score >= 71) return "#22c55e"; // green-500
  if (score >= 41) return "#eab308"; // yellow-500
  return "#ef4444"; // red-500
}

export function ScoreGauge({
  score,
  size = 160,
  label,
}: ScoreGaugeProps & { label: string }) {
  const color = getScoreColor(score);
  const stroke = 10;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const normalizedScore = Math.max(0, Math.min(100, score));
  const offset = circumference * (1 - normalizedScore / 100);

  return (
    <div className="flex flex-col items-center gap-2">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="block"
        role="img"
        aria-label={`Score ${score}`}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="hsl(var(--muted))"
          strokeWidth={stroke}
          fill="transparent"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={color}
          strokeWidth={stroke}
          fill="transparent"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={Math.round(size * 0.25)}
          fontWeight={700}
          fill={color}
        >
          {score}
        </text>
      </svg>
      <span className="text-sm font-medium text-muted-foreground">
        {label}
      </span>
    </div>
  );
}
