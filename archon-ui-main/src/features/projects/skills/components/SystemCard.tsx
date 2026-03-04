import type { SystemWithSkills } from "../types";

interface SystemCardProps {
	system: SystemWithSkills;
	isSelected: boolean;
	onClick: () => void;
}

export function SystemCard({ system, isSelected, onClick }: SystemCardProps) {
	const isOnline = isRecentlyActive(system.last_seen_at);
	const skillCount = system.skills?.length ?? 0;

	return (
		<button
			type="button"
			onClick={onClick}
			className={`w-full text-left p-3 rounded-lg border transition-colors ${
				isSelected
					? "border-cyan-500/50 bg-cyan-500/10"
					: "border-white/10 bg-white/5 hover:border-white/20 hover:bg-white/[0.07]"
			}`}
		>
			<div className="flex items-center gap-2">
				<span className={`w-2 h-2 rounded-full ${isOnline ? "bg-emerald-400" : "bg-zinc-500"}`} />
				<span className="font-medium text-sm text-white truncate">{system.name}</span>
			</div>
			<div className="mt-1 text-xs text-zinc-400">
				{skillCount} skill{skillCount !== 1 ? "s" : ""}
				{system.hostname && ` · ${system.hostname}`}
			</div>
		</button>
	);
}

function isRecentlyActive(lastSeen: string): boolean {
	const fiveMinutes = 5 * 60 * 1000;
	return Date.now() - new Date(lastSeen).getTime() < fiveMinutes;
}
