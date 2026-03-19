interface SystemBadgeProps {
  name: string;
  os: string | null;
  className?: string;
}

const OS_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  Windows: { bg: "bg-blue-500/15", text: "text-blue-300", border: "border-blue-500/20" },
  Darwin: { bg: "bg-green-500/12", text: "text-green-300", border: "border-green-500/15" },
  Linux: { bg: "bg-orange-500/15", text: "text-orange-300", border: "border-orange-500/20" },
};

const DEFAULT_COLOR = { bg: "bg-white/10", text: "text-gray-400", border: "border-white/10" };

export function SystemBadge({ name, os, className = "" }: SystemBadgeProps) {
  const colors = (os && OS_COLORS[os]) || DEFAULT_COLOR;

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] border ${colors.bg} ${colors.text} ${colors.border} ${className}`}
    >
      {name}
    </span>
  );
}
