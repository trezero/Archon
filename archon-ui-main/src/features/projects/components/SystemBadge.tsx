interface SystemBadgeProps {
  name: string;
  os: string | null;
  className?: string;
}

interface ColorSet { bg: string; text: string; border: string }

const WINDOWS_COLOR: ColorSet = { bg: "bg-blue-500/15", text: "text-blue-300", border: "border-blue-500/20" };
const MAC_COLOR: ColorSet = { bg: "bg-green-500/12", text: "text-green-300", border: "border-green-500/15" };
const LINUX_COLOR: ColorSet = { bg: "bg-[rgba(234,88,12,0.15)]", text: "text-[#fdba74]", border: "border-orange-500/20" };
const DEFAULT_COLOR: ColorSet = { bg: "bg-white/10", text: "text-gray-400", border: "border-white/10" };

function resolveOsColor(os: string | null): ColorSet {
  if (!os) return DEFAULT_COLOR;
  const lower = os.toLowerCase();
  if (lower.includes("win") || lower.includes("mingw")) return WINDOWS_COLOR;
  if (lower.includes("darwin") || lower.includes("mac")) return MAC_COLOR;
  if (lower.includes("linux") || lower.includes("ubuntu") || lower.includes("wsl")) return LINUX_COLOR;
  return DEFAULT_COLOR;
}

export function SystemBadge({ name, os, className = "" }: SystemBadgeProps) {
  const colors = resolveOsColor(os);

  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs border ${colors.bg} ${colors.text} ${colors.border} ${className}`}
    >
      {name}
    </span>
  );
}
