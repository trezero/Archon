import { Copy, ExternalLink } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { useToast } from "../../ui/hooks";
import { Button, cn, glassmorphism, Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/primitives";
import type { McpServerConfig, McpServerStatus, SupportedIDE } from "../types";

interface McpConfigSectionProps {
  config?: McpServerConfig;
  status: McpServerStatus;
  className?: string;
}

const ideConfigurations: Record<
  SupportedIDE,
  {
    title: string;
    steps: string[];
    configGenerator: (config: McpServerConfig) => string;
    supportsOneClick?: boolean;
  }
> = {
  claudecode: {
    title: "Claude Code Configuration",
    steps: ["Open a terminal and run the following command:", "The connection will be established automatically"],
    configGenerator: (config) =>
      JSON.stringify(
        {
          name: "archon",
          transport: "http",
          url: `http://${config.host}:${config.port}/mcp`,
        },
        null,
        2,
      ),
  },
  gemini: {
    title: "Gemini CLI Configuration",
    steps: [
      "Locate or create the settings file at ~/.gemini/settings.json",
      "Add the configuration shown below to the file",
      "Launch Gemini CLI in your terminal",
      "Test the connection by typing /mcp to list available tools",
    ],
    configGenerator: (config) =>
      JSON.stringify(
        {
          mcpServers: {
            archon: {
              httpUrl: `http://${config.host}:${config.port}/mcp`,
            },
          },
        },
        null,
        2,
      ),
  },
  cursor: {
    title: "Cursor Configuration",
    steps: [
      "Option A: Use the one-click install button below (recommended)",
      "Option B: Manually edit ~/.cursor/mcp.json",
      "Add the configuration shown below",
      "Restart Cursor for changes to take effect",
    ],
    configGenerator: (config) =>
      JSON.stringify(
        {
          mcpServers: {
            archon: {
              url: `http://${config.host}:${config.port}/mcp`,
            },
          },
        },
        null,
        2,
      ),
    supportsOneClick: true,
  },
  windsurf: {
    title: "Windsurf Configuration",
    steps: [
      'Open Windsurf and click the "MCP servers" button (hammer icon)',
      'Click "Configure" and then "View raw config"',
      "Add the configuration shown below to the mcpServers object",
      'Click "Refresh" to connect to the server',
    ],
    configGenerator: (config) =>
      JSON.stringify(
        {
          mcpServers: {
            archon: {
              serverUrl: `http://${config.host}:${config.port}/mcp`,
            },
          },
        },
        null,
        2,
      ),
  },
  cline: {
    title: "Cline Configuration",
    steps: [
      "Open VS Code settings (Cmd/Ctrl + ,)",
      'Search for "cline.mcpServers"',
      'Click "Edit in settings.json"',
      "Add the configuration shown below",
      "Restart VS Code for changes to take effect",
    ],
    configGenerator: (config) =>
      JSON.stringify(
        {
          mcpServers: {
            archon: {
              command: "npx",
              args: ["mcp-remote", `http://${config.host}:${config.port}/mcp`, "--allow-http"],
            },
          },
        },
        null,
        2,
      ),
  },
  kiro: {
    title: "Kiro Configuration",
    steps: [
      "Open Kiro settings",
      "Navigate to MCP Servers section",
      "Add the configuration shown below",
      "Save and restart Kiro",
    ],
    configGenerator: (config) =>
      JSON.stringify(
        {
          mcpServers: {
            archon: {
              command: "npx",
              args: ["mcp-remote", `http://${config.host}:${config.port}/mcp`, "--allow-http"],
            },
          },
        },
        null,
        2,
      ),
  },
  augment: {
    title: "Augment Configuration",
    steps: [
      "Open Augment settings",
      "Navigate to Extensions > MCP",
      "Add the configuration shown below",
      "Reload configuration",
    ],
    configGenerator: (config) =>
      JSON.stringify(
        {
          mcpServers: {
            archon: {
              url: `http://${config.host}:${config.port}/mcp`,
            },
          },
        },
        null,
        2,
      ),
  },
};

export const McpConfigSection: React.FC<McpConfigSectionProps> = ({ config, status, className }) => {
  const [selectedIDE, setSelectedIDE] = useState<SupportedIDE>("claudecode");
  const { showToast } = useToast();

  if (status.status !== "running" || !config) {
    return (
      <div
        className={cn(
          "p-6 text-center rounded-lg",
          glassmorphism.background.subtle,
          glassmorphism.border.default,
          className,
        )}
      >
        <p className="text-zinc-400">Start the MCP server to see configuration options</p>
      </div>
    );
  }

  const handleCopyConfig = () => {
    const configText = ideConfigurations[selectedIDE].configGenerator(config);
    navigator.clipboard.writeText(configText);
    showToast("Configuration copied to clipboard", "success");
  };

  const handleCursorOneClick = () => {
    const httpConfig = {
      url: `http://${config.host}:${config.port}/mcp`,
    };
    const configString = JSON.stringify(httpConfig);
    const base64Config = btoa(configString);
    const deeplink = `cursor://anysphere.cursor-deeplink/mcp/install?name=archon&config=${base64Config}`;
    window.location.href = deeplink;
    showToast("Opening Cursor with Archon MCP configuration...", "info");
  };

  const handleClaudeCodeCommand = () => {
    const command = `claude mcp add --transport http archon http://${config.host}:${config.port}/mcp`;
    navigator.clipboard.writeText(command);
    showToast("Command copied to clipboard", "success");
  };

  const selectedConfig = ideConfigurations[selectedIDE];
  const configText = selectedConfig.configGenerator(config);

  return (
    <div className={cn("space-y-6", className)}>
      {/* Universal MCP Note */}
      <div className={cn("p-3 rounded-lg", glassmorphism.background.blue, glassmorphism.border.blue)}>
        <p className="text-sm text-blue-700 dark:text-blue-300">
          <span className="font-semibold">Note:</span> Archon works with any application that supports MCP. Below are
          instructions for common tools, but these steps can be adapted for any MCP-compatible client.
        </p>
      </div>

      {/* IDE Selection Tabs */}
      <Tabs
        defaultValue="claudecode"
        value={selectedIDE}
        onValueChange={(value) => setSelectedIDE(value as SupportedIDE)}
      >
        <TabsList className="grid grid-cols-4 lg:grid-cols-7 w-full">
          <TabsTrigger value="claudecode">Claude Code</TabsTrigger>
          <TabsTrigger value="gemini">Gemini</TabsTrigger>
          <TabsTrigger value="cursor">Cursor</TabsTrigger>
          <TabsTrigger value="windsurf">Windsurf</TabsTrigger>
          <TabsTrigger value="cline">Cline</TabsTrigger>
          <TabsTrigger value="kiro">Kiro</TabsTrigger>
          <TabsTrigger value="augment">Augment</TabsTrigger>
        </TabsList>

        <TabsContent value={selectedIDE} className="mt-6 space-y-4">
          {/* Configuration Title and Steps */}
          <div>
            <h4 className="text-lg font-semibold text-gray-800 dark:text-white mb-3">{selectedConfig.title}</h4>
            <ol className="list-decimal list-inside space-y-2 text-sm text-gray-600 dark:text-zinc-400">
              {selectedConfig.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>

          {/* Special Commands for Claude Code */}
          {selectedIDE === "claudecode" && (
            <div
              className={cn(
                "p-3 rounded-lg flex items-center justify-between",
                glassmorphism.background.subtle,
                glassmorphism.border.default,
              )}
            >
              <code className="text-sm font-mono text-cyan-600 dark:text-cyan-400">
                claude mcp add --transport http archon http://{config.host}:{config.port}/mcp
              </code>
              <Button variant="outline" size="sm" onClick={handleClaudeCodeCommand}>
                <Copy className="w-3 h-3 mr-1" />
                Copy
              </Button>
            </div>
          )}

          {/* Configuration Display */}
          <div className={cn("relative rounded-lg p-4", glassmorphism.background.subtle, glassmorphism.border.default)}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Configuration</span>
              <Button variant="outline" size="sm" onClick={handleCopyConfig}>
                <Copy className="w-3 h-3 mr-1" />
                Copy
              </Button>
            </div>
            <pre className="text-xs font-mono text-gray-800 dark:text-zinc-200 overflow-x-auto">
              <code>{configText}</code>
            </pre>
          </div>

          {/* One-Click Install for Cursor */}
          {selectedIDE === "cursor" && selectedConfig.supportsOneClick && (
            <div className="flex items-center gap-3">
              <Button variant="cyan" onClick={handleCursorOneClick} className="shadow-lg">
                <ExternalLink className="w-4 h-4 mr-2" />
                One-Click Install for Cursor
              </Button>
              <span className="text-xs text-zinc-500">Opens Cursor with configuration</span>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
};
