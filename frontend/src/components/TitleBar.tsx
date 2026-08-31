import { Search } from 'lucide-react';

interface TitleBarProps {
  /** Global search query (sessions / agents / files). */
  searchQuery: string;
  onSearchChange: (value: string) => void;
}

// Width reserved at the left for the native macOS traffic lights
// (BrowserWindow uses titleBarStyle: 'hiddenInset', trafficLightPosition {10,10}).
const TRAFFIC_LIGHT_GUTTER = 72;

/**
 * TitleBar — 38px Protoflow-style window chrome.
 *
 * The whole bar is a drag region (WebkitAppRegion: drag); interactive controls
 * opt out with `no-drag`. The left gutter is empty space reserved for the
 * native macOS traffic lights. The center hosts a global search field.
 */
export function TitleBar({
  searchQuery,
  onSearchChange,
}: TitleBarProps) {
  return (
    <div
      data-testid="title-bar"
      className="flex h-[38px] flex-shrink-0 items-center gap-3 border-b border-border-primary bg-bg-secondary pr-3"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Reserve space for native macOS traffic lights */}
      <div style={{ width: TRAFFIC_LIGHT_GUTTER }} className="flex-shrink-0" />

      {/* Centered search */}
      <div
        className="mx-auto flex w-full max-w-[520px] items-center gap-2 border border-border-primary bg-bg-primary px-2.5 text-text-tertiary focus-within:border-border-hover"
        style={{ WebkitAppRegion: 'no-drag', height: 22 } as React.CSSProperties}
      >
        <Search className="h-3 w-3 flex-shrink-0" strokeWidth={1.6} />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search sessions, agents, files…"
          className="w-full bg-transparent text-[11px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
          aria-label="Search sessions, agents, files"
        />
      </div>
    </div>
  );
}
