import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkBreaks from 'remark-breaks';
import type { ChatMessage } from '@/lib/types';
import { cn } from '@/lib/utils';

interface MessageBubbleProps {
  message: ChatMessage;
}

export function MessageBubble({ message }: MessageBubbleProps): React.ReactElement {
  const isUser = message.role === 'user';

  return (
    <div className={cn('group flex w-full', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'relative',
          isUser
            ? 'max-w-[70%] rounded-2xl rounded-br-sm bg-accent-muted px-4 py-2.5'
            : 'max-w-full rounded-lg border-l-2 border-border pl-4'
        )}
      >
        {isUser ? (
          <p className="text-sm text-text-primary whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className="chat-markdown max-w-none text-sm text-text-primary">
            {message.isStreaming && !message.content && (
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
            <ReactMarkdown
              remarkPlugins={[remarkBreaks]}
              rehypePlugins={[rehypeHighlight]}
              components={{
                pre: ({ children, ...props }): React.ReactElement => (
                  <pre
                    className="overflow-x-auto rounded-lg border border-border bg-surface p-4 font-mono text-sm"
                    {...props}
                  >
                    {children}
                  </pre>
                ),
                code: ({ children, className, ...props }): React.ReactElement => {
                  const isBlock =
                    className?.startsWith('language-') || className?.startsWith('hljs');
                  if (isBlock) {
                    return (
                      <code className={cn(className, 'font-mono')} {...props}>
                        {children}
                      </code>
                    );
                  }
                  return (
                    <code
                      className="rounded bg-surface px-1.5 py-0.5 font-mono text-sm text-primary"
                      {...props}
                    >
                      {children}
                    </code>
                  );
                },
                blockquote: ({ children, ...props }): React.ReactElement => (
                  <blockquote
                    className="border-l-2 border-primary pl-4 text-text-secondary"
                    {...props}
                  >
                    {children}
                  </blockquote>
                ),
                a: ({ children, ...props }): React.ReactElement => (
                  <a
                    className="text-primary underline decoration-primary/40 hover:decoration-primary"
                    target="_blank"
                    rel="noopener noreferrer"
                    {...props}
                  >
                    {children}
                  </a>
                ),
              }}
            >
              {message.content}
            </ReactMarkdown>
            {message.isStreaming && (
              <span className="inline-block h-4 w-0.5 animate-pulse bg-primary align-text-bottom" />
            )}
          </div>
        )}

        <div className="mt-0.5 text-[11px] text-text-tertiary">
          {new Date(message.timestamp).toLocaleTimeString()}
        </div>
      </div>
    </div>
  );
}
