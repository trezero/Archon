import { Download } from "lucide-react";

export function ArchonSetupDownload() {
  return (
    <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-6">
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-cyan-500/10 flex items-center justify-center">
          <Download className="w-5 h-5 text-cyan-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold text-white mb-1">Connect a New Machine</h2>
          <p className="text-sm text-zinc-400 mb-4">
            Download the setup script and run it in your project directory. It adds Archon to Claude
            Code and installs the{" "}
            <code className="text-cyan-300 bg-white/5 px-1 rounded">/archon-setup</code> command in
            one step.
          </p>
          <div className="flex flex-wrap gap-3 mb-4">
            <a
              href="/archon-setup.sh"
              download="archonSetup.sh"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-sm font-medium hover:bg-cyan-500/20 transition-colors"
            >
              <Download className="w-4 h-4" />
              archonSetup.sh
              <span className="text-xs text-zinc-500">Mac / Linux</span>
            </a>
            <a
              href="/archon-setup.bat"
              download="archonSetup.bat"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-zinc-300 text-sm font-medium hover:bg-white/10 transition-colors"
            >
              <Download className="w-4 h-4" />
              archonSetup.bat
              <span className="text-xs text-zinc-500">Windows</span>
            </a>
          </div>
          <p className="text-xs text-zinc-500">
            Then open Claude Code in your project and run{" "}
            <code className="text-cyan-400">/archon-setup</code> to register your system and install
            skills.
          </p>
        </div>
      </div>
    </div>
  );
}
