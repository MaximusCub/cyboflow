import { useEffect, useRef } from 'react';

interface SessionActionToastProps {
  message: string;
  isVisible: boolean;
  onDismiss: () => void;
  durationMs?: number;
  actionLabel?: string;
  onAction?: () => void;
}

export function SessionActionToast({
  message,
  isVisible,
  onDismiss,
  durationMs = 3000,
  actionLabel,
  onAction,
}: SessionActionToastProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pausedRef = useRef(false);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const startTimer = () => {
    clearTimer();
    timerRef.current = setTimeout(onDismiss, durationMs);
  };

  useEffect(() => {
    if (!isVisible) return;
    pausedRef.current = false;
    startTimer();
    return clearTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, onDismiss, durationMs]);

  if (!isVisible) return null;

  const handlePause = () => {
    pausedRef.current = true;
    clearTimer();
  };

  const handleResume = () => {
    if (!pausedRef.current) return;
    pausedRef.current = false;
    startTimer();
  };

  return (
    <div
      data-testid="session-action-toast"
      role="status"
      className="bg-status-success text-white rounded px-4 py-2 text-sm font-medium shadow-lg flex items-center gap-3"
      onMouseEnter={handlePause}
      onMouseLeave={handleResume}
      onFocus={handlePause}
      onBlur={handleResume}
    >
      <span>{message}</span>
      {actionLabel !== undefined && onAction !== undefined && (
        <button
          type="button"
          data-testid="session-action-toast-action"
          onClick={onAction}
          className="underline underline-offset-2 font-semibold hover:opacity-80"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
