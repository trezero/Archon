import { useEffect, useRef, useState, useCallback, type RefObject } from 'react';

export function useAutoScroll(
  containerRef: RefObject<HTMLElement | null>,
  dependencies: unknown[]
): {
  isAtBottom: boolean;
  scrollToBottom: () => void;
} {
  const [isAtBottom, setIsAtBottom] = useState(true);
  const userScrolledUpRef = useRef(false);

  const scrollToBottom = useCallback((): void => {
    const el = containerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      userScrolledUpRef.current = false;
      setIsAtBottom(true);
    }
  }, [containerRef]);

  // Detect user scroll position
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleScroll = (): void => {
      const threshold = 50;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
      setIsAtBottom(atBottom);
      userScrolledUpRef.current = !atBottom;
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    return (): void => {
      el.removeEventListener('scroll', handleScroll);
    };
  }, [containerRef]);

  // Auto-scroll when dependencies change (new messages)
  useEffect(() => {
    if (!userScrolledUpRef.current) {
      scrollToBottom();
    }
  }, dependencies);

  return { isAtBottom, scrollToBottom };
}
