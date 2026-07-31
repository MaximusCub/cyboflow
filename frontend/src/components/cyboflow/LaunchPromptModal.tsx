/**
 * LaunchPromptModal — the pre-launch seed-prompt gate for the Launch flow (the
 * interview-driven super-planner, the 5th built-in workflow). Before a Launch
 * run starts, the user answers "What are you trying to build?" in free text so
 * the interview agent's first turn is grounded in something concrete rather
 * than starting cold. The trimmed answer is threaded into
 * runs.start.mutate({ seedPrompt }) — optional, Launch-only, 1..4000 chars
 * after trim (the contract WorkflowPicker / SessionStartWizard / QuickSessionCanvas
 * all pass through unchanged).
 *
 * Mirrors IdeaPickerModal / TaskBatchPickerModal: shared Modal primitives and
 * the same footer button styling. Simpler than those — there's no async
 * mutation here, just a client-side validity gate — so submit is a plain
 * onSubmit callback; the caller owns the actual launch.
 */
import { useEffect, useState } from 'react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../ui/Modal';

/** Contract cap (runs.start `seedPrompt`): 1..4000 chars after trim. */
const MAX_LENGTH = 4000;

interface LaunchPromptModalProps {
  open: boolean;
  onCancel: () => void;
  onSubmit: (seedPrompt: string) => void;
}

export function LaunchPromptModal({ open, onCancel, onSubmit }: LaunchPromptModalProps): React.JSX.Element {
  const [text, setText] = useState('');

  // Reset the draft whenever the modal opens fresh, so a cancelled attempt
  // never leaks stale text into the next open.
  useEffect(() => {
    if (open) setText('');
  }, [open]);

  const trimmed = text.trim();
  const canSubmit = trimmed.length > 0 && trimmed.length <= MAX_LENGTH;

  const handleSubmit = (): void => {
    if (!canSubmit) return;
    onSubmit(trimmed);
  };

  return (
    <Modal isOpen={open} onClose={onCancel} size="md">
      <ModalHeader>What are you trying to build?</ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-3">
          <p className="text-xs text-text-secondary">
            One or two sentences is plenty — the interview digs into the rest.
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                handleSubmit();
              }
            }}
            rows={5}
            maxLength={MAX_LENGTH}
            placeholder="e.g. A Chrome extension that summarizes long articles into three bullet points before I read them."
            className="resize-none rounded-input border border-border-primary bg-input-bg px-2 py-1.5 text-sm text-input-text placeholder:text-input-placeholder"
            aria-label="What are you trying to build?"
            autoFocus
          />
        </div>
      </ModalBody>
      <ModalFooter>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-hover"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          data-testid="launch-prompt-submit"
          className="rounded-button bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          Start interview
        </button>
      </ModalFooter>
    </Modal>
  );
}
