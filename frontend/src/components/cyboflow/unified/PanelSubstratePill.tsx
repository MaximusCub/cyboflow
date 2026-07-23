import React from 'react';
import { ChevronDown, Cpu } from 'lucide-react';
import type { CliSubstrate } from '../../../../../shared/types/substrate';
import { API } from '../../../utils/api';
import { Dropdown, type DropdownItem } from '../../ui/Dropdown';
import { Pill } from '../../ui/Pill';

interface PanelSubstratePillProps {
  panelId: string;
  sessionSubstrate?: CliSubstrate;
}

/** Per-panel routing for added chats; omitted panels inherit session routing. */
export function PanelSubstratePill({ panelId, sessionSubstrate }: PanelSubstratePillProps): React.ReactElement {
  const [override, setOverride] = React.useState<CliSubstrate | null>(null);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    const getSubstrate = API.claudePanels.getSubstrate;
    if (typeof getSubstrate !== 'function') return () => { cancelled = true; };
    getSubstrate(panelId).then((res) => {
      if (!cancelled && res.success) setOverride(res.data ?? null);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [panelId]);

  const effective = override ?? sessionSubstrate ?? 'sdk';
  const effectiveLabel = effective === 'sdk' ? 'SDK' : 'PTY';
  const label = override === null ? `Inherit · ${effectiveLabel}` : `${effectiveLabel} override`;
  const select = async (value: CliSubstrate | null): Promise<void> => {
    setOpen(false);
    if (value === override) return;
    const previous = override;
    setOverride(value);
    try {
      const setSubstrate = API.claudePanels.setSubstrate;
      if (typeof setSubstrate !== 'function') return;
      const res = await setSubstrate(panelId, value);
      if (!res.success) setOverride(previous);
    } catch {
      setOverride(previous);
    }
  };

  const items: DropdownItem[] = [
    { id: 'inherit', label: `Inherit session · ${effectiveLabel}`, description: 'Keep the session routing (recommended)', onClick: () => void select(null) },
    { id: 'sdk', label: 'SDK override', description: 'Run this chat with the Claude SDK', onClick: () => void select('sdk') },
    { id: 'interactive', label: 'PTY override', description: 'Run this chat with the interactive terminal', onClick: () => void select('interactive') },
  ];
  const trigger = <Pill size="sm" icon={<Cpu className="h-3.5 w-3.5" />}>{label}<ChevronDown className="h-3 w-3" /></Pill>;

  return (
    <div className="flex items-center gap-1" title="Two live substrates can write the same worktree concurrently.">
      <Dropdown
        trigger={trigger}
        items={items}
        selectedId={override ?? 'inherit'}
        position="auto"
        onOpenChange={setOpen}
        footer={open ? (
          <p className="border-t border-border-primary px-3 py-2 text-[10px] leading-snug text-status-warning">
            Two live substrates can write this worktree concurrently. Avoid overlapping turns.
          </p>
        ) : undefined}
      />
    </div>
  );
}
