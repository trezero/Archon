import {
  useState,
  useRef,
  useCallback,
  forwardRef,
  useImperativeHandle,
  type KeyboardEvent,
  type DragEvent,
  type ClipboardEvent,
} from 'react';
import { ArrowUp, Loader2, Paperclip, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

const ACCEPTED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/x-python',
  'text/javascript',
  'text/typescript',
  'application/json',
];

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_FILES = 5;

interface MessageInputProps {
  onSend: (message: string, files?: File[]) => void;
  disabled: boolean;
  disabledReason?: string;
}

export interface MessageInputHandle {
  focus: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${String(Math.round(bytes / (1024 * 1024)))} MB`;
}

const messageInput = forwardRef<MessageInputHandle, MessageInputProps>(function MessageInputInner(
  { onSend, disabled, disabledReason }: MessageInputProps,
  ref
): React.ReactElement {
  const [value, setValue] = useState('');
  const [files, setFiles] = useState<{ file: File; id: string }[]>([]);
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focus: (): void => {
      textareaRef.current?.focus();
    },
  }));

  const addFiles = useCallback((incoming: File[]): void => {
    setFileError(null);
    setFiles(prev => {
      const combined = [...prev];
      for (const file of incoming) {
        if (combined.length >= MAX_FILES) {
          setFileError(`Maximum ${String(MAX_FILES)} files per message`);
          break;
        }
        if (file.size > MAX_FILE_BYTES) {
          setFileError(`"${file.name}" exceeds the 10 MB size limit`);
          continue;
        }
        if (!ACCEPTED_MIME_TYPES.includes(file.type)) {
          setFileError(`"${file.name}" is not a supported file type`);
          continue;
        }
        combined.push({ file, id: crypto.randomUUID() });
      }
      return combined;
    });
  }, []);

  const removeFile = useCallback((id: string): void => {
    setFiles(prev => prev.filter(f => f.id !== id));
    setFileError(null);
  }, []);

  const handleSend = useCallback((): void => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed, files.length > 0 ? files.map(f => f.file) : undefined);
    setValue('');
    setFiles([]);
    setFileError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
  }, [value, disabled, onSend, files]);

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

  const handleFilePickerChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    if (e.target.files) addFiles(Array.from(e.target.files));
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragging(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>): void => {
    // Only clear dragging when leaving the outer container, not a child element
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setDragging(false);
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) addFiles(Array.from(e.dataTransfer.files));
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const imageItems = Array.from(e.clipboardData.items).filter(item =>
      item.type.startsWith('image/')
    );
    if (imageItems.length === 0) return;
    const pastedFiles: File[] = [];
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (file) pastedFiles.push(file);
    }
    if (pastedFiles.length > 0) {
      e.preventDefault();
      addFiles(pastedFiles);
    }
  };

  return (
    <div
      className={`border-t border-border bg-surface p-4 transition-colors${dragging ? ' bg-primary/5' : ''}`}
      title={disabledReason}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        {/* File preview chips */}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {files.map(({ file, id }) => (
              <div
                key={id}
                className="flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-text-secondary"
              >
                <span className="max-w-[140px] truncate" title={file.name}>
                  {file.name}
                </span>
                <span className="text-text-tertiary">({formatBytes(file.size)})</span>
                <button
                  type="button"
                  onClick={() => {
                    removeFile(id);
                  }}
                  className="ml-1 text-text-tertiary hover:text-text-primary"
                  aria-label={`Remove ${file.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* File error */}
        {fileError !== null && <p className="text-xs text-destructive">{fileError}</p>}

        {/* Input row */}
        <div className="flex items-end gap-2">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPTED_MIME_TYPES.join(',')}
            className="hidden"
            onChange={handleFilePickerChange}
            disabled={disabled}
          />

          {/* Attach button */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled || files.length >= MAX_FILES}
            onClick={() => fileInputRef.current?.click()}
            className="h-10 w-10 shrink-0 text-text-tertiary hover:text-text-primary"
            title="Attach file"
          >
            <Paperclip className="h-4 w-4" />
          </Button>

          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={disabled}
            placeholder={dragging ? 'Drop files here...' : (disabledReason ?? 'Message Archon...')}
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
    </div>
  );
});

export { messageInput as MessageInput };
