import type { Extension, SystemExtension } from "../types";
import { ExtensionStatusBadge } from "./ExtensionStatusBadge";

interface SystemExtensionListProps {
  systemExtensions: SystemExtension[];
  allExtensions: Extension[];
  onInstall: (extensionId: string) => void;
  onRemove: (extensionId: string) => void;
}

export function SystemExtensionList({ systemExtensions, allExtensions, onInstall, onRemove }: SystemExtensionListProps) {
  const installedExtensionIds = new Set(systemExtensions.map((se) => se.extension_id));
  const availableExtensions = allExtensions.filter((e) => !installedExtensionIds.has(e.id));

  return (
    <div className="space-y-4">
      {systemExtensions.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Installed Extensions</h4>
          <div className="space-y-1">
            {systemExtensions.map((se) => (
              <div key={se.id} className="flex items-center justify-between p-2 rounded-md bg-white/5">
                <span className="text-sm text-white">
                  {se.archon_extensions?.display_name || se.archon_extensions?.name || se.extension_id}
                </span>
                <div className="flex items-center gap-2">
                  <ExtensionStatusBadge status={se.status} hasLocalChanges={se.has_local_changes} />
                  <button
                    type="button"
                    onClick={() => onRemove(se.extension_id)}
                    className="px-2 py-1 text-xs rounded-md bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {availableExtensions.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Available</h4>
          <div className="space-y-1">
            {availableExtensions.map((extension) => (
              <div key={extension.id} className="flex items-center justify-between p-2 rounded-md bg-white/5">
                <div>
                  <span className="text-sm text-white">{extension.display_name || extension.name}</span>
                  {extension.is_required && <span className="ml-2 text-xs text-cyan-400">Required</span>}
                </div>
                <button
                  type="button"
                  onClick={() => onInstall(extension.id)}
                  className="px-3 py-1 text-xs rounded-md bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-500/30 transition-colors"
                >
                  Install
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {systemExtensions.length === 0 && availableExtensions.length === 0 && (
        <div className="text-center py-8 text-zinc-500 text-sm">
          No extensions in the registry yet. Extensions are added when systems sync.
        </div>
      )}
    </div>
  );
}
