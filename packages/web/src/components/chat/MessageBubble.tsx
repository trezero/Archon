import { memo, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import type { ChatMessage } from '@/lib/types';
import { cn } from '@/lib/utils';

// Hoisted to module scope to prevent new references on every render
const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const REHYPE_PLUGINS = [rehypeHighlight];

const MARKDOWN_COMPONENTS = {
  pre: ({ children, ...props }: React.ComponentPropsWithoutRef<'pre'>): React.ReactElement => (
    <pre
      className="overflow-x-auto rounded-lg border border-border bg-surface p-4 font-mono text-sm"
      {...props}
    >
      {children}
    </pre>
  ),
  code: ({
    children,
    className,
    ...props
  }: React.ComponentPropsWithoutRef<'code'> & { className?: string }): React.ReactElement => {
    const isBlock = className?.startsWith('language-') || className?.startsWith('hljs');
    if (isBlock) {
      return (
        <code className={cn(className, 'font-mono')} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="rounded bg-background px-1.5 py-0.5 font-mono text-sm text-accent-bright"
        {...props}
      >
        {children}
      </code>
    );
  },
  table: ({ children, ...props }: React.ComponentPropsWithoutRef<'table'>): React.ReactElement => (
    <div className="overflow-x-auto">
      <table {...props}>{children}</table>
    </div>
  ),
  blockquote: ({
    children,
    ...props
  }: React.ComponentPropsWithoutRef<'blockquote'>): React.ReactElement => (
    <blockquote className="border-l-2 border-primary pl-4 text-text-secondary" {...props}>
      {children}
    </blockquote>
  ),
  a: ({ children, ...props }: React.ComponentPropsWithoutRef<'a'>): React.ReactElement => (
    <a
      className="text-primary underline decoration-primary/40 hover:decoration-primary"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  ),
};

/** Detect if a string is a complete JSON object/array */
function isJsonString(str: string): boolean {
  const trimmed = str.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

interface MessageBubbleProps {
  message: ChatMessage;
}

function MessageBubbleRaw({ message }: MessageBubbleProps): React.ReactElement {
  const isUser = message.role === 'user';
  const isThinking = message.isStreaming && !message.content;
  const [copied, setCopied] = useState(false);

  const copyMessage = (): void => {
    void navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 1500);
    });
  };

  return (
    <div className={cn('group flex w-full', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'relative',
          isUser
            ? 'max-w-[70%] rounded-2xl rounded-br-sm bg-accent-muted px-4 py-2.5'
            : 'max-w-full rounded-lg border-l-2 border-primary/30 pl-4'
        )}
      >
        {isUser ? (
          <div className="flex items-start gap-2">
            <p className="text-sm text-text-primary whitespace-pre-wrap flex-1">
              {message.content}
            </p>
            <button
              onClick={copyMessage}
              className="shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity text-text-tertiary hover:text-text-primary"
              title="Copy message"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-success" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        ) : (
          <div className="chat-markdown max-w-none text-sm text-text-primary">
            {isThinking && (
              <div className="flex items-center gap-1.5 py-1">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-text-tertiary" />
                <span
                  className="h-1.5 w-1.5 animate-pulse rounded-full bg-text-tertiary"
                  style={{ animationDelay: '0.2s' }}
                />
                <span
                  className="h-1.5 w-1.5 animate-pulse rounded-full bg-text-tertiary"
                  style={{ animationDelay: '0.4s' }}
                />
              </div>
            )}
            {isJsonString(message.content) ? (
              <details className="group">
                <summary className="cursor-pointer text-sm text-text-secondary hover:text-text-primary">
                  <span className="text-xs bg-surface-secondary rounded px-1.5 py-0.5 font-mono">
                    JSON output
                  </span>
                </summary>
                <pre className="mt-2 text-xs bg-surface-inset rounded p-3 overflow-x-auto">
                  {JSON.stringify(JSON.parse(message.content.trim()) as unknown, null, 2)}
                </pre>
              </details>
            ) : (
              <ReactMarkdown
                remarkPlugins={REMARK_PLUGINS}
                rehypePlugins={REHYPE_PLUGINS}
                components={MARKDOWN_COMPONENTS}
              >
                {message.content}
              </ReactMarkdown>
            )}
            {message.isStreaming && message.content && (
              <span className="inline-block h-4 w-0.5 animate-pulse bg-primary align-text-bottom" />
            )}
          </div>
        )}

        {!isThinking && (
          <div className="mt-0.5 text-[11px] text-text-tertiary">
            {new Date(message.timestamp).toLocaleTimeString()}
          </div>
        )}
      </div>
    </div>
  );
}

// Memoize: only re-render when message content/state actually changes
const messageBubble = memo(MessageBubbleRaw, (prev, next) => {
  return (
    prev.message.content === next.message.content &&
    prev.message.isStreaming === next.message.isStreaming &&
    prev.message.toolCalls === next.message.toolCalls &&
    prev.message.error === next.message.error &&
    prev.message.workflowDispatch === next.message.workflowDispatch &&
    prev.message.workflowResult === next.message.workflowResult
  );
});

export { messageBubble as MessageBubble };
