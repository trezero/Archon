import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useEffect } from 'react';
import { Header } from '@/components/layout/Header';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  getConfig,
  getHealth,
  listCodebases,
  addCodebase,
  deleteCodebase,
  updateAssistantConfig,
} from '@/lib/api';
import type { SafeConfigResponse, CodebaseResponse } from '@/lib/api';

const selectClass =
  'h-9 rounded-md border border-border bg-surface-elevated text-text-primary px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring [&>option]:bg-surface-elevated [&>option]:text-text-primary';

function SystemHealthSection({
  health,
  database,
}: {
  health:
    | {
        status: string;
        adapter: string;
        concurrency: { active: number; queuedTotal: number; maxConcurrent: number };
        runningWorkflows: number;
      }
    | undefined;
  database: string | undefined;
}): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle>System Health</CardTitle>
      </CardHeader>
      <CardContent>
        {!health ? (
          <div className="text-sm text-muted-foreground">Loading...</div>
        ) : (
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <div>
              <span className="text-muted-foreground">Status: </span>
              <Badge variant={health.status === 'ok' ? 'default' : 'destructive'}>
                {health.status}
              </Badge>
            </div>
            <div>
              <span className="text-muted-foreground">Adapter: </span>
              <span className="font-medium">{health.adapter}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Database: </span>
              <span className="font-medium">{database ?? 'unknown'}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Active: </span>
              <span className="font-medium">
                {health.concurrency.active}/{health.concurrency.maxConcurrent}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Queued: </span>
              <span className="font-medium">{health.concurrency.queuedTotal}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Workflows: </span>
              <span className="font-medium">{health.runningWorkflows}</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ProjectsSection(): React.ReactElement {
  const queryClient = useQueryClient();
  const [addPath, setAddPath] = useState('');
  const [showAdd, setShowAdd] = useState(false);

  const { data: codebases } = useQuery({
    queryKey: ['codebases'],
    queryFn: listCodebases,
  });

  const addMutation = useMutation({
    mutationFn: (path: string) => addCodebase({ path }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['codebases'] });
      setAddPath('');
      setShowAdd(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteCodebase(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['codebases'] });
    },
  });

  function handleAddSubmit(e: React.FormEvent): void {
    e.preventDefault();
    if (addPath.trim()) {
      addMutation.mutate(addPath.trim());
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Projects</CardTitle>
      </CardHeader>
      <CardContent>
        {!codebases || codebases.length === 0 ? (
          <div className="text-sm text-muted-foreground">No projects registered.</div>
        ) : (
          <div className="space-y-2">
            {codebases.map((cb: CodebaseResponse) => (
              <div
                key={cb.id}
                className="flex items-center justify-between rounded-md border border-border p-2 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{cb.name}</div>
                  <div className="text-xs text-muted-foreground truncate">{cb.default_cwd}</div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    deleteMutation.mutate(cb.id);
                  }}
                  disabled={deleteMutation.isPending}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        )}

        {showAdd ? (
          <form onSubmit={handleAddSubmit} className="mt-3 flex gap-2">
            <Input
              value={addPath}
              onChange={e => {
                setAddPath(e.target.value);
              }}
              placeholder="/path/to/repository"
              className="flex-1"
            />
            <Button type="submit" size="sm" disabled={addMutation.isPending}>
              Add
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowAdd(false);
                setAddPath('');
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => {
              setShowAdd(true);
            }}
          >
            + Add Project
          </Button>
        )}

        {addMutation.isError && (
          <div className="mt-2 text-sm text-destructive">
            {addMutation.error instanceof Error
              ? addMutation.error.message
              : 'Failed to add project'}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AssistantConfigSection({ config }: { config: SafeConfigResponse }): React.ReactElement {
  const queryClient = useQueryClient();
  const [assistant, setAssistant] = useState(config.assistant);
  const [claudeModel, setClaudeModel] = useState(config.assistants.claude.model ?? 'sonnet');
  const [codexModel, setCodexModel] = useState(config.assistants.codex.model ?? '');
  const [reasoning, setReasoning] = useState<'minimal' | 'low' | 'medium' | 'high' | 'xhigh'>(
    config.assistants.codex.modelReasoningEffort ?? 'medium'
  );
  const [webSearch, setWebSearch] = useState<'disabled' | 'cached' | 'live'>(
    config.assistants.codex.webSearchMode ?? 'disabled'
  );
  const [saveMsg, setSaveMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const hasChanges =
    assistant !== config.assistant ||
    claudeModel !== (config.assistants.claude.model ?? 'sonnet') ||
    codexModel !== (config.assistants.codex.model ?? '') ||
    reasoning !== (config.assistants.codex.modelReasoningEffort ?? 'medium') ||
    webSearch !== (config.assistants.codex.webSearchMode ?? 'disabled');

  useEffect(() => {
    setAssistant(config.assistant);
    setClaudeModel(config.assistants.claude.model ?? 'sonnet');
    setCodexModel(config.assistants.codex.model ?? '');
    setReasoning(config.assistants.codex.modelReasoningEffort ?? 'medium');
    setWebSearch(config.assistants.codex.webSearchMode ?? 'disabled');
  }, [config]);

  const mutation = useMutation({
    mutationFn: updateAssistantConfig,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['config'] });
      setSaveMsg({ type: 'success', text: 'Settings saved.' });
      setTimeout(() => {
        setSaveMsg(null);
      }, 3000);
    },
    onError: (err: Error) => {
      setSaveMsg({ type: 'error', text: err.message });
    },
  });

  function handleSave(): void {
    mutation.mutate({
      assistant,
      claude: { model: claudeModel },
      // The generated type requires `model` when `codex` is present; omit the codex key
      // entirely when no model is set so the server treats it as "no codex changes".
      ...(codexModel
        ? {
            codex: { model: codexModel, modelReasoningEffort: reasoning, webSearchMode: webSearch },
          }
        : {}),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Assistant Configuration</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="grid grid-cols-[140px_1fr] items-center gap-2 text-sm">
            <label htmlFor="default-assistant">Default Assistant</label>
            <select
              id="default-assistant"
              value={assistant}
              onChange={e => {
                setAssistant(e.target.value as 'claude' | 'codex');
              }}
              className={selectClass}
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>

            <label htmlFor="claude-model">Claude Model</label>
            <select
              id="claude-model"
              value={claudeModel}
              onChange={e => {
                setClaudeModel(e.target.value);
              }}
              className={selectClass}
            >
              <option value="sonnet">sonnet</option>
              <option value="opus">opus</option>
              <option value="haiku">haiku</option>
            </select>

            <label htmlFor="codex-model">Codex Model</label>
            <Input
              id="codex-model"
              value={codexModel}
              onChange={e => {
                setCodexModel(e.target.value);
              }}
              placeholder="gpt-5.3-codex"
            />

            <label htmlFor="reasoning">Reasoning Effort</label>
            <select
              id="reasoning"
              value={reasoning}
              onChange={e => {
                setReasoning(e.target.value as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh');
              }}
              className={selectClass}
            >
              <option value="minimal">minimal</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="xhigh">xhigh</option>
            </select>

            <label htmlFor="web-search">Web Search</label>
            <select
              id="web-search"
              value={webSearch}
              onChange={e => {
                setWebSearch(e.target.value as 'disabled' | 'cached' | 'live');
              }}
              className={selectClass}
            >
              <option value="disabled">disabled</option>
              <option value="cached">cached</option>
              <option value="live">live</option>
            </select>
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={handleSave} disabled={mutation.isPending || !hasChanges} size="sm">
              {mutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            {saveMsg && (
              <span
                className={`text-sm ${saveMsg.type === 'success' ? 'text-green-500' : 'text-destructive'}`}
              >
                {saveMsg.text}
              </span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PlatformConnectionsSection({
  adapter,
}: {
  adapter: string | undefined;
}): React.ReactElement {
  const platforms = [
    { name: 'Web', connected: adapter === 'web' },
    { name: 'Slack', connected: false },
    { name: 'Telegram', connected: false },
    { name: 'Discord', connected: false },
    { name: 'GitHub', connected: false },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Platform Connections</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {platforms.map(p => (
            <div key={p.name} className="flex items-center justify-between text-sm">
              <span>{p.name}</span>
              <Badge variant={p.connected ? 'default' : 'secondary'}>
                {p.connected ? 'Connected' : 'Not configured'}
              </Badge>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ConcurrencySection({
  health,
}: {
  health: { concurrency: { active: number; maxConcurrent: number } } | undefined;
}): React.ReactElement {
  const active = health?.concurrency.active ?? 0;
  const max = health?.concurrency.maxConcurrent ?? 1;
  const pct = max > 0 ? Math.min((active / max) * 100, 100) : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Concurrency</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <div className="h-3 w-full rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${String(pct)}%` }}
            />
          </div>
          <div className="text-sm text-muted-foreground">
            {active} / {max} concurrent conversations
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function SettingsPage(): React.ReactElement {
  const {
    data: configData,
    isLoading: configLoading,
    error: configError,
  } = useQuery({
    queryKey: ['config'],
    queryFn: getConfig,
  });

  const {
    data: health,
    isLoading: healthLoading,
    error: healthError,
  } = useQuery({
    queryKey: ['health'],
    queryFn: getHealth,
  });

  const isLoading = configLoading || healthLoading;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <Header title="Settings" />
      <div className="flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-5xl space-y-6">
          {(configError || healthError) && (
            <div className="text-sm text-destructive">
              Failed to load settings:{' '}
              {((): string => {
                const err = configError ?? healthError;
                return err instanceof Error ? err.message : 'Unknown error';
              })()}
              . Check that the server is running.
            </div>
          )}

          {isLoading && <div className="text-sm text-muted-foreground">Loading settings...</div>}

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <SystemHealthSection health={health} database={configData?.database} />
            <ConcurrencySection health={health} />
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {configData && <AssistantConfigSection config={configData.config} />}
            <PlatformConnectionsSection adapter={health?.adapter} />
          </div>

          <ProjectsSection />
        </div>
      </div>
    </div>
  );
}
