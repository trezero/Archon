import { useState, useRef, useCallback, type KeyboardEvent } from 'react';
import { ArrowUp, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface MessageInputProps {
  onSend: (message: string) => void;
  disabled: boolean;
  disabledReason?: string;
}

export function MessageInput({
  onSend,
  disabled,
  disabledReason,
}: MessageInputProps): React.ReactElement {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback((): void => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue('');
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
  }, [value, disabled, onSend]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setValue(e.target.value);
    // Auto-expand textarea
    const textarea = e.target;
    textarea.style.height = 'auto';
    textarea.style.height = `${String(Math.min(textarea.scrollHeight, 200))}px`;
  };

  return (
    <div className="border-t border-border bg-surface p-4" title={disabledReason}>
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={disabledReason ?? 'Message Archon...'}
          rows={1}
          className="flex-1 resize-none rounded-lg border border-border bg-background px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          style={{ maxHeight: '200px' }}
        />
        <Button
          onClick={handleSend}
          disabled={disabled || !value.trim()}
          size="icon"
          className="h-10 w-10 shrink-0 rounded-lg bg-primary text-primary-foreground hover:bg-accent-hover disabled:opacity-50"
        >
          {disabled && !disabledReason ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ArrowUp className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
