import { useState, useCallback } from 'react';
import { TRIGGER_RULES } from '@archon/core/workflows/types';
import type { TriggerRule } from '@archon/core/workflows/types';
import type { DagNodeData } from './DagNodeComponent';
import type { CommandEntry } from '@/lib/api';
import type { SingleStep, ParallelBlock } from '@archon/core/workflows/types';

interface DagInspectorProps {
  mode: 'dag';
  node: DagNodeData;
  commands: CommandEntry[];
  onUpdate: (updates: Partial<DagNodeData>) => void;
  onDelete: () => void;
}

interface SequentialInspectorProps {
  mode: 'sequential';
  step: SingleStep;
  stepIndex: number;
  commands: CommandEntry[];
  onUpdate: (updates: Partial<SingleStep>) => void;
  onDelete: () => void;
}

interface ParallelBlockInspectorProps {
  mode: 'parallel';
  block: ParallelBlock;
  blockIndex: number;
  commands: CommandEntry[];
  /** Takes a full ParallelBlock (not partial) because the sub-step array must be replaced atomically. */
  onUpdate: (block: ParallelBlock) => void;
  onUngroup: () => void;
  onDelete: () => void;
}

type NodeInspectorProps =
  | DagInspectorProps
  | SequentialInspectorProps
  | ParallelBlockInspectorProps;

function ToolsInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string[] | undefined;
  onChange: (v: string[] | undefined) => void;
}): React.ReactElement {
  const text = value?.join(', ') ?? '';
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] text-text-tertiary uppercase tracking-wide">{label}</label>
      <input
        type="text"
        value={text}
        onChange={(e): void => {
          const v = e.target.value;
          if (!v.trim()) {
            onChange(undefined);
          } else {
            onChange(
              v
                .split(',')
                .map(s => s.trim())
                .filter(Boolean)
            );
          }
        }}
        placeholder="tool1, tool2..."
        className="w-full rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
      />
    </div>
  );
}

function DagInspector({
  node,
  commands,
  onUpdate,
  onDelete,
}: Omit<DagInspectorProps, 'mode'>): React.ReactElement {
  const [outputFormatText, setOutputFormatText] = useState(
    node.output_format ? JSON.stringify(node.output_format, null, 2) : ''
  );
  const [outputFormatError, setOutputFormatError] = useState<string | null>(null);
  const [showOutputFormat, setShowOutputFormat] = useState(!!node.output_format);

  const handleOutputFormatChange = useCallback(
    (text: string): void => {
      setOutputFormatText(text);
      if (!text.trim()) {
        setOutputFormatError(null);
        onUpdate({ output_format: undefined });
        return;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch (e) {
        setOutputFormatError(e instanceof SyntaxError ? e.message : 'Invalid JSON');
        return;
      }
      setOutputFormatError(null);
      onUpdate({ output_format: parsed });
    },
    [onUpdate]
  );

  const isBash = node.nodeType === 'bash';

  return (
    <div className="flex flex-wrap gap-3 items-start">
      {/* ID */}
      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-text-tertiary uppercase tracking-wide">Node ID</label>
        <span className="text-xs text-text-secondary font-mono">{node.id}</span>
      </div>

      {/* Command, Prompt, or Bash */}
      {isBash ? (
        <div className="flex flex-col gap-1 flex-1 min-w-[200px]">
          <label className="text-[10px] text-text-tertiary uppercase tracking-wide">
            Shell Script
          </label>
          <textarea
            value={node.bashScript ?? ''}
            onChange={(e): void => {
              onUpdate({ bashScript: e.target.value });
            }}
            rows={3}
            placeholder="echo 'hello world'"
            className="w-full rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-primary font-mono placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent resize-y"
          />
        </div>
      ) : node.nodeType === 'command' ? (
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-text-tertiary uppercase tracking-wide">Command</label>
          <select
            value={node.label}
            onChange={(e): void => {
              onUpdate({ label: e.target.value });
            }}
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="">Select...</option>
            {commands.map(cmd => (
              <option key={cmd.name} value={cmd.name}>
                {cmd.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div className="flex flex-col gap-1 flex-1 min-w-[200px]">
          <label className="text-[10px] text-text-tertiary uppercase tracking-wide">Prompt</label>
          <textarea
            value={node.promptText ?? ''}
            onChange={(e): void => {
              onUpdate({ promptText: e.target.value });
            }}
            rows={2}
            placeholder="Enter inline prompt..."
            className="w-full rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent resize-y"
          />
        </div>
      )}

      {/* Bash-specific: Timeout */}
      {isBash && (
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-text-tertiary uppercase tracking-wide">
            Timeout (ms)
          </label>
          <input
            type="number"
            value={node.bashTimeout ?? ''}
            onChange={(e): void => {
              const v = e.target.value;
              onUpdate({ bashTimeout: v ? Number(v) : undefined });
            }}
            placeholder="120000"
            className="w-28 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
      )}

      {/* AI-only fields (Provider, Model, Context, Tools, Output Format); Trigger Rule and When Condition below apply to all node types */}
      {!isBash && (
        <>
          {/* Provider */}
          <div className="flex flex-col gap-1">
            <label className="text-[10px] text-text-tertiary uppercase tracking-wide">
              Provider
            </label>
            <select
              value={node.provider ?? ''}
              onChange={(e): void => {
                onUpdate({
                  provider: (e.target.value || undefined) as 'claude' | 'codex' | undefined,
                });
              }}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            >
              <option value="">Inherited</option>
              <option value="claude">claude</option>
              <option value="codex">codex</option>
            </select>
          </div>

          {/* Model */}
          <div className="flex flex-col gap-1">
            <label className="text-[10px] text-text-tertiary uppercase tracking-wide">Model</label>
            <input
              type="text"
              value={node.model ?? ''}
              onChange={(e): void => {
                onUpdate({ model: e.target.value || undefined });
              }}
              placeholder="Inherited"
              className="w-28 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
        </>
      )}

      {/* Trigger Rule (applicable to all node types) */}
      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-text-tertiary uppercase tracking-wide">
          Trigger Rule
        </label>
        <select
          value={node.trigger_rule ?? ''}
          onChange={(e): void => {
            onUpdate({
              trigger_rule: (e.target.value || undefined) as TriggerRule | undefined,
            });
          }}
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <option value="">Default (all_success)</option>
          {TRIGGER_RULES.map(rule => (
            <option key={rule} value={rule}>
              {rule}
            </option>
          ))}
        </select>
      </div>

      {/* Context (AI-only) */}
      {!isBash && (
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-text-tertiary uppercase tracking-wide">
            Fresh Context
          </label>
          <label className="flex items-center gap-1.5 text-xs text-text-primary cursor-pointer">
            <input
              type="checkbox"
              checked={node.context === 'fresh'}
              onChange={(e): void => {
                onUpdate({ context: e.target.checked ? 'fresh' : undefined });
              }}
              className="rounded"
            />
            <span>Reset session</span>
          </label>
        </div>
      )}

      {/* When condition (applicable to all node types) */}
      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-text-tertiary uppercase tracking-wide">
          When Condition
        </label>
        <input
          type="text"
          value={node.when ?? ''}
          onChange={(e): void => {
            onUpdate({ when: e.target.value || undefined });
          }}
          placeholder="e.g. $classify.output.type == 'BUG'"
          className="w-64 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      {/* Tools (AI-only) */}
      {!isBash && (
        <>
          <ToolsInput
            label="Allowed Tools"
            value={node.allowed_tools}
            onChange={(v): void => {
              onUpdate({ allowed_tools: v });
            }}
          />
          <ToolsInput
            label="Denied Tools"
            value={node.denied_tools}
            onChange={(v): void => {
              onUpdate({ denied_tools: v });
            }}
          />
        </>
      )}

      {/* Output Format (hidden for Bash and explicit Codex nodes; inherited provider may still be Codex at runtime) */}
      {!isBash && node.provider !== 'codex' && (
        <div className="flex flex-col gap-1 w-full">
          <button
            type="button"
            onClick={(): void => {
              setShowOutputFormat(!showOutputFormat);
            }}
            className="text-[10px] text-text-tertiary uppercase tracking-wide text-left hover:text-text-secondary"
          >
            Output Format (JSON Schema) {showOutputFormat ? '[-]' : '[+]'}
          </button>
          {showOutputFormat && (
            <>
              <textarea
                value={outputFormatText}
                onChange={(e): void => {
                  handleOutputFormatChange(e.target.value);
                }}
                rows={4}
                placeholder='{"type": "object", "properties": {...}}'
                className="w-full rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-primary font-mono placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent resize-y"
              />
              {outputFormatError && <p className="text-xs text-error">{outputFormatError}</p>}
            </>
          )}
        </div>
      )}

      {/* Delete */}
      <div className="flex flex-col gap-1 ml-auto">
        <button
          type="button"
          onClick={onDelete}
          className="rounded-md border border-error/30 bg-error/10 px-3 py-1 text-xs text-error hover:bg-error/20 transition-colors"
        >
          Delete Node
        </button>
      </div>
    </div>
  );
}

function SequentialInspector({
  step,
  stepIndex,
  commands,
  onUpdate,
  onDelete,
}: Omit<SequentialInspectorProps, 'mode'>): React.ReactElement {
  return (
    <div className="flex flex-wrap gap-3 items-start">
      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-text-tertiary uppercase tracking-wide">
          Step {String(stepIndex + 1)}
        </label>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-text-tertiary uppercase tracking-wide">Command</label>
        <select
          value={step.command}
          onChange={(e): void => {
            onUpdate({ command: e.target.value });
          }}
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <option value="">Select...</option>
          {commands.map(cmd => (
            <option key={cmd.name} value={cmd.name}>
              {cmd.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-text-tertiary uppercase tracking-wide">
          Clear Context
        </label>
        <label className="flex items-center gap-1.5 text-xs text-text-primary cursor-pointer">
          <input
            type="checkbox"
            checked={step.clearContext ?? false}
            onChange={(e): void => {
              onUpdate({ clearContext: e.target.checked || undefined });
            }}
            className="rounded"
          />
          <span>Fresh session</span>
        </label>
      </div>

      <ToolsInput
        label="Allowed Tools"
        value={step.allowed_tools}
        onChange={(v): void => {
          onUpdate({ allowed_tools: v });
        }}
      />
      <ToolsInput
        label="Denied Tools"
        value={step.denied_tools}
        onChange={(v): void => {
          onUpdate({ denied_tools: v });
        }}
      />

      <div className="flex flex-col gap-1 ml-auto">
        <button
          type="button"
          onClick={onDelete}
          className="rounded-md border border-error/30 bg-error/10 px-3 py-1 text-xs text-error hover:bg-error/20 transition-colors"
        >
          Delete Step
        </button>
      </div>
    </div>
  );
}

function ParallelBlockInspector({
  block,
  blockIndex,
  commands,
  onUpdate,
  onUngroup,
  onDelete,
}: Omit<ParallelBlockInspectorProps, 'mode'>): React.ReactElement {
  const subSteps = block.parallel;

  const updateSubStep = useCallback(
    (subIndex: number, updates: Partial<SingleStep>): void => {
      const newParallel = [...subSteps];
      newParallel[subIndex] = { ...newParallel[subIndex], ...updates };
      onUpdate({ parallel: newParallel });
    },
    [subSteps, onUpdate]
  );

  const removeSubStep = useCallback(
    (subIndex: number): void => {
      if (subSteps.length <= 2) {
        // Auto-ungroup when fewer than 2 would remain
        onUngroup();
        return;
      }
      const newParallel = subSteps.filter((_, i) => i !== subIndex);
      onUpdate({ parallel: newParallel });
    },
    [subSteps, onUpdate, onUngroup]
  );

  const addSubStep = useCallback(
    (command: string): void => {
      const newStep: SingleStep = { command };
      onUpdate({ parallel: [...subSteps, newStep] });
    },
    [subSteps, onUpdate]
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
        Parallel Block ({String(subSteps.length)} steps) &mdash; Step {String(blockIndex + 1)}
      </div>

      {subSteps.map((sub, i) => (
        <div key={i} className="rounded-lg border border-border bg-surface p-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-text-tertiary font-mono">{String(i + 1)}</span>
            <select
              value={sub.command}
              onChange={(e): void => {
                updateSubStep(i, { command: e.target.value });
              }}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent flex-1"
            >
              <option value="">Select...</option>
              {commands.map(cmd => (
                <option key={cmd.name} value={cmd.name}>
                  {cmd.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={(): void => {
                removeSubStep(i);
              }}
              className="text-text-tertiary hover:text-error transition-colors text-xs"
              title="Remove sub-step"
            >
              Remove
            </button>
          </div>

          <div className="flex flex-wrap gap-3 items-start">
            <label className="flex items-center gap-1.5 text-xs text-text-primary cursor-pointer">
              <input
                type="checkbox"
                checked={sub.clearContext ?? false}
                onChange={(e): void => {
                  updateSubStep(i, { clearContext: e.target.checked || undefined });
                }}
                className="rounded"
              />
              <span>Clear context</span>
            </label>
            <ToolsInput
              label="Allowed Tools"
              value={sub.allowed_tools}
              onChange={(v): void => {
                updateSubStep(i, { allowed_tools: v });
              }}
            />
            <ToolsInput
              label="Denied Tools"
              value={sub.denied_tools}
              onChange={(v): void => {
                updateSubStep(i, { denied_tools: v });
              }}
            />
          </div>
        </div>
      ))}

      {/* Add Sub-Step */}
      <select
        value=""
        onChange={(e): void => {
          if (e.target.value) {
            addSubStep(e.target.value);
            e.target.value = '';
          }
        }}
        className="w-full rounded-md border border-dashed border-border bg-surface px-2 py-1.5 text-xs text-text-secondary focus:outline-none focus:ring-1 focus:ring-accent"
      >
        <option value="">+ Add Sub-Step...</option>
        {commands.map(cmd => (
          <option key={cmd.name} value={cmd.name}>
            {cmd.name}
          </option>
        ))}
      </select>

      {/* Actions */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onUngroup}
          className="rounded-md border border-border px-3 py-1 text-xs text-text-secondary hover:bg-surface-hover transition-colors"
        >
          Ungroup
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="rounded-md border border-error/30 bg-error/10 px-3 py-1 text-xs text-error hover:bg-error/20 transition-colors ml-auto"
        >
          Delete Block
        </button>
      </div>
    </div>
  );
}

export function NodeInspector(props: NodeInspectorProps): React.ReactElement {
  if (props.mode === 'dag') {
    return (
      <div className="border-t border-border px-4 py-3">
        <DagInspector
          node={props.node}
          commands={props.commands}
          onUpdate={props.onUpdate}
          onDelete={props.onDelete}
        />
      </div>
    );
  }

  if (props.mode === 'parallel') {
    return (
      <div className="border-t border-border px-4 py-3">
        <ParallelBlockInspector
          block={props.block}
          blockIndex={props.blockIndex}
          commands={props.commands}
          onUpdate={props.onUpdate}
          onUngroup={props.onUngroup}
          onDelete={props.onDelete}
        />
      </div>
    );
  }

  return (
    <div className="border-t border-border px-4 py-3">
      <SequentialInspector
        step={props.step}
        stepIndex={props.stepIndex}
        commands={props.commands}
        onUpdate={props.onUpdate}
        onDelete={props.onDelete}
      />
    </div>
  );
}
