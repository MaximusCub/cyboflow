/**
 * useSaveRunTypeDefault — the whole "Save as default" + Undo subsystem for a
 * run-type key, shared by the two launch surfaces (WorkflowPicker and the
 * Session Start Wizard's Configure step).
 *
 * Two invariants here are load-bearing and easy to regress:
 *
 * 1. **An Undo payload is recorded only when the store confirms the write.** A
 *    failed write leaves the stored default exactly as it was, so replaying
 *    `{ kind: 'replace', value: null }` for it would DELETE a default the failed
 *    write never overwrote — data loss reached purely through an error path.
 *    `previous === null` therefore means one thing only: the write landed and
 *    the key genuinely held nothing, so Undo deletes the key.
 *
 * 2. **The in-flight latch is a ref, read and set synchronously in the handler.**
 *    A `useState` flag (and the `disabled` attribute derived from it) only takes
 *    effect on the next render, so two clicks in the same tick both observe
 *    `false` and both write — and whichever promise settled last would become
 *    the visible Undo record, restoring the wrong prior entry.
 *
 * Saving is independent of launching in both directions: this hook writes config
 * and nothing else — it never touches the caller's live launch controls, so the
 * in-flight launch payload is identical before and after a save.
 */
import { useCallback, useRef, useState } from 'react';
import { useConfigStore } from '../stores/configStore';
import type {
  RunTypeDefaults,
  RunTypeDefaultsPatch,
} from '../../../shared/types/sessionDefaults';

/**
 * How long the save confirmation stays up. Deliberately longer than
 * SessionActionToast's 3s default: the toast carries the only Undo affordance
 * for a write that has already hit disk, and 3s is below the usual bar for an
 * undo window. Owned here so both surfaces cannot drift.
 */
export const SAVE_DEFAULT_TOAST_MS = 9000;

export interface SaveRunTypeDefaultToast {
  message: string;
  tone: 'success' | 'error';
}

export interface UseSaveRunTypeDefaultOptions {
  /** The run-type key to write. `null` means "no writable target yet" — saving is a no-op. */
  key: string | null;
  /** Human label for the toast copy ("Custom", "Quick sessions", …). */
  label: string;
}

export interface UseSaveRunTypeDefaultReturn {
  save: (patch: RunTypeDefaultsPatch) => void;
  undo: () => void;
  /** True only after a write the store confirmed landed. */
  canUndo: boolean;
  isSaving: boolean;
  toast: SaveRunTypeDefaultToast | null;
  dismissToast: () => void;
}

interface UndoRecord {
  key: string;
  label: string;
  /** `null` = the key held nothing before the (confirmed) write; Undo deletes it. */
  previous: RunTypeDefaults | null;
}

export function useSaveRunTypeDefault({
  key,
  label,
}: UseSaveRunTypeDefaultOptions): UseSaveRunTypeDefaultReturn {
  const applyRunTypeDefault = useConfigStore((s) => s.applyRunTypeDefault);
  const inFlightRef = useRef(false);
  const [isSaving, setIsSaving] = useState(false);
  const [toast, setToast] = useState<SaveRunTypeDefaultToast | null>(null);
  const [undoRecord, setUndoRecord] = useState<UndoRecord | null>(null);

  const save = useCallback(
    (patch: RunTypeDefaultsPatch): void => {
      if (key === null || inFlightRef.current) return;
      inFlightRef.current = true;
      setIsSaving(true);
      // Key and label are captured HERE, not read at resolution time, so
      // switching flows while the write is in flight cannot relabel the
      // confirmation or misdirect its Undo.
      const writeKey = key;
      const writeLabel = label;
      void (async () => {
        try {
          const result = await applyRunTypeDefault(writeKey, { kind: 'merge', value: patch });
          if (result.ok) {
            setUndoRecord({ key: writeKey, label: writeLabel, previous: result.previous });
            setToast({ message: `Saved as default for ${writeLabel}`, tone: 'success' });
          } else {
            setUndoRecord(null);
            setToast({ message: `Couldn't save default for ${writeLabel}`, tone: 'error' });
          }
        } finally {
          inFlightRef.current = false;
          setIsSaving(false);
        }
      })();
    },
    [key, label, applyRunTypeDefault],
  );

  const undo = useCallback((): void => {
    if (undoRecord === null || inFlightRef.current) return;
    const record = undoRecord;
    inFlightRef.current = true;
    setIsSaving(true);
    setToast(null);
    setUndoRecord(null);
    void (async () => {
      try {
        const result = await applyRunTypeDefault(record.key, {
          kind: 'replace',
          value: record.previous,
        });
        if (!result.ok) {
          setToast({ message: `Couldn't undo default for ${record.label}`, tone: 'error' });
        }
      } finally {
        inFlightRef.current = false;
        setIsSaving(false);
      }
    })();
  }, [undoRecord, applyRunTypeDefault]);

  const dismissToast = useCallback((): void => setToast(null), []);

  return {
    save,
    undo,
    canUndo: undoRecord !== null,
    isSaving,
    toast,
    dismissToast,
  };
}
