interface SystemBadgeProps {
  name: string;
  os: string | null;
  className?: string;
}

interface ColorSet { bg: string; text: string; border: string }

// Vibrant palette — every system gets a color. The same name always maps to the same color.
const PALETTE: ColorSet[] = [
  { bg: "bg-blue-500/15", text: "text-blue-300", border: "border-blue-500/20" },
  { bg: "bg-emerald-500/15", text: "text-emerald-300", border: "border-emerald-500/20" },
  { bg: "bg-[rgba(234,88,12,0.15)]", text: "text-[#fdba74]", border: "border-orange-500/20" },
  { bg: "bg-violet-500/15", text: "text-violet-300", border: "border-violet-500/20" },
  { bg: "bg-cyan-500/15", text: "text-cyan-300", border: "border-cyan-500/20" },
  { bg: "bg-rose-500/15", text: "text-rose-300", border: "border-rose-500/20" },
  { bg: "bg-amber-500/15", text: "text-amber-300", border: "border-amber-500/20" },
  { bg: "bg-teal-500/15", text: "text-teal-300", border: "border-teal-500/20" },
  { bg: "bg-fuchsia-500/15", text: "text-fuchsia-300", border: "border-fuchsia-500/20" },
  { bg: "bg-sky-500/15", text: "text-sky-300", border: "border-sky-500/20" },
];

function hashName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function resolveColor(name: string): ColorSet {
  return PALETTE[hashName(name) % PALETTE.length];
}

export function SystemBadge({ name, className = "" }: SystemBadgeProps) {
  const colors = resolveColor(name);

  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs border ${colors.bg} ${colors.text} ${colors.border} ${className}`}
    >
      {name}
    </span>
  );
}
