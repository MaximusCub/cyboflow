/**
 * InteractivePrototypeEmbed — the v1 process-isolated interactive canvas.
 * Covers the ensure/render happy path, the fail-soft states (ensure failure,
 * bridge absent, server-stopped), the frame-terminated overlay + reload
 * cache-busting, runId-scoped event filtering, and the onEvent unsubscribe on
 * unmount. `window.electronAPI.designPrototypeServer` is mocked per test.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type {
  EnsurePrototypeServerRequest,
  EnsurePrototypeServerResult,
  PrototypeServerEvent,
  StopPrototypeServerResult,
} from '../../../../../../shared/types/designPrototypeServer';
import type { IPCResponse } from '../../../../utils/api';

import { InteractivePrototypeEmbed } from '../InteractivePrototypeEmbed';

type EventCallback = (event: PrototypeServerEvent) => void;

function installBridge(overrides?: {
  ensure?: (req: EnsurePrototypeServerRequest) => Promise<IPCResponse<EnsurePrototypeServerResult>>;
}) {
  const ensure = vi.fn(
    overrides?.ensure ??
      ((): Promise<IPCResponse<EnsurePrototypeServerResult>> =>
        Promise.resolve({ success: true, data: { baseUrl: 'http://127.0.0.1:9999/tok/prototype/index.html' } })),
  );
  const stop = vi.fn(
    (): Promise<IPCResponse<StopPrototypeServerResult>> => Promise.resolve({ success: true, data: { stopped: true } }),
  );
  const listeners: EventCallback[] = [];
  const unsubscribe = vi.fn();
  const onEvent = vi.fn((cb: EventCallback) => {
    listeners.push(cb);
    return unsubscribe;
  });

  (window as unknown as { electronAPI: unknown }).electronAPI = {
    designPrototypeServer: { ensure, stop, onEvent },
  };

  return {
    ensure,
    stop,
    onEvent,
    unsubscribe,
    // The main process pushes these outside any React event handler, so tests
    // must wrap delivery in act() themselves for the resulting setState to flush.
    emit: (event: PrototypeServerEvent) => act(() => listeners.forEach((cb) => cb(event))),
  };
}

describe('InteractivePrototypeEmbed', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('calls ensure on mount with the runId', async () => {
    const bridge = installBridge();
    render(<InteractivePrototypeEmbed runId="run-1" />);
    await waitFor(() => expect(bridge.ensure).toHaveBeenCalledWith({ runId: 'run-1' }));
  });

  it('renders the iframe with the resolved baseUrl and sandbox="allow-scripts" exactly on success', async () => {
    installBridge();
    render(<InteractivePrototypeEmbed runId="run-1" />);
    const iframe = await screen.findByTestId('interactive-embed-iframe');
    expect(iframe).toHaveAttribute('src', 'http://127.0.0.1:9999/tok/prototype/index.html');
    expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
    expect(screen.queryByTestId('interactive-embed-loading')).not.toBeInTheDocument();
  });

  it('shows the loading state while ensure is in flight', async () => {
    let resolveEnsure: (v: IPCResponse<EnsurePrototypeServerResult>) => void = () => {};
    installBridge({
      ensure: () =>
        new Promise((resolve) => {
          resolveEnsure = resolve;
        }),
    });
    render(<InteractivePrototypeEmbed runId="run-1" />);
    expect(screen.getByTestId('interactive-embed-loading')).toBeInTheDocument();
    // Drain the pending promise so it doesn't leak into the next test.
    await act(async () => {
      resolveEnsure({ success: true, data: { baseUrl: 'http://127.0.0.1:9999/tok/prototype/index.html' } });
    });
  });

  it('shows the error state on ensure failure, and Retry re-calls ensure', async () => {
    const bridge = installBridge({
      ensure: () => Promise.resolve({ success: false, error: 'boom' }),
    });
    render(<InteractivePrototypeEmbed runId="run-1" />);
    await screen.findByTestId('interactive-embed-error');
    expect(screen.getByText('Prototype server unavailable')).toBeInTheDocument();
    expect(bridge.ensure).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(bridge.ensure).toHaveBeenCalledTimes(2));
  });

  it('fails soft to the error state when the bridge is absent', async () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    render(<InteractivePrototypeEmbed runId="run-1" />);
    await screen.findByTestId('interactive-embed-error');
    expect(screen.getByText('Prototype server unavailable')).toBeInTheDocument();
  });

  it('a frame-terminated event for this runId shows the terminated overlay over the (still-mounted) iframe', async () => {
    const bridge = installBridge();
    render(<InteractivePrototypeEmbed runId="run-1" />);
    await screen.findByTestId('interactive-embed-iframe');

    bridge.emit({ runId: 'run-1', kind: 'frame-terminated', reason: 'cpu' });

    expect(screen.getByTestId('interactive-embed-terminated')).toBeInTheDocument();
    expect(screen.getByText('Prototype terminated — it pegged the CPU')).toBeInTheDocument();
    // The iframe stays in the DOM underneath the overlay.
    expect(screen.getByTestId('interactive-embed-iframe')).toBeInTheDocument();
  });

  it('memory-reason termination shows the memory copy', async () => {
    const bridge = installBridge();
    render(<InteractivePrototypeEmbed runId="run-1" />);
    await screen.findByTestId('interactive-embed-iframe');
    bridge.emit({ runId: 'run-1', kind: 'frame-terminated', reason: 'memory' });
    expect(screen.getByText('Prototype terminated — it exhausted memory')).toBeInTheDocument();
  });

  it('Reload prototype re-sets the iframe src with a cache-busting query param and clears the overlay', async () => {
    const bridge = installBridge();
    render(<InteractivePrototypeEmbed runId="run-1" />);
    const iframe = await screen.findByTestId('interactive-embed-iframe');
    const originalSrc = iframe.getAttribute('src');

    bridge.emit({ runId: 'run-1', kind: 'frame-terminated', reason: 'cpu' });
    expect(screen.getByTestId('interactive-embed-terminated')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('interactive-embed-reload'));

    expect(screen.queryByTestId('interactive-embed-terminated')).not.toBeInTheDocument();
    const newSrc = screen.getByTestId('interactive-embed-iframe').getAttribute('src');
    expect(newSrc).not.toBe(originalSrc);
    expect(newSrc).toBe(`${originalSrc}?r=1`);
  });

  it('ignores a frame-terminated event for a different runId', async () => {
    const bridge = installBridge();
    render(<InteractivePrototypeEmbed runId="run-1" />);
    await screen.findByTestId('interactive-embed-iframe');
    bridge.emit({ runId: 'run-OTHER', kind: 'frame-terminated', reason: 'cpu' });
    expect(screen.queryByTestId('interactive-embed-terminated')).not.toBeInTheDocument();
  });

  it('a server-stopped event replaces the iframe with the fail-soft state, and Restart re-ensures + renders the fresh baseUrl', async () => {
    let call = 0;
    const bridge = installBridge({
      ensure: () => {
        call += 1;
        const baseUrl =
          call === 1
            ? 'http://127.0.0.1:9999/tok-a/prototype/index.html'
            : 'http://127.0.0.1:9999/tok-b/prototype/index.html';
        return Promise.resolve({ success: true, data: { baseUrl } });
      },
    });
    render(<InteractivePrototypeEmbed runId="run-1" />);
    const iframe = await screen.findByTestId('interactive-embed-iframe');
    expect(iframe).toHaveAttribute('src', 'http://127.0.0.1:9999/tok-a/prototype/index.html');

    bridge.emit({ runId: 'run-1', kind: 'server-stopped' });

    expect(screen.queryByTestId('interactive-embed-iframe')).not.toBeInTheDocument();
    const errorState = screen.getByTestId('interactive-embed-error');
    expect(errorState).toBeInTheDocument();
    expect(screen.getByText('Prototype server stopped')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));

    const revived = await screen.findByTestId('interactive-embed-iframe');
    expect(revived).toHaveAttribute('src', 'http://127.0.0.1:9999/tok-b/prototype/index.html');
    expect(bridge.ensure).toHaveBeenCalledTimes(2);
  });

  it('ignores a server-stopped event for a different runId', async () => {
    const bridge = installBridge();
    render(<InteractivePrototypeEmbed runId="run-1" />);
    await screen.findByTestId('interactive-embed-iframe');
    bridge.emit({ runId: 'run-OTHER', kind: 'server-stopped' });
    expect(screen.getByTestId('interactive-embed-iframe')).toBeInTheDocument();
  });

  it('unsubscribes from onEvent on unmount', async () => {
    const bridge = installBridge();
    const { unmount } = render(<InteractivePrototypeEmbed runId="run-1" />);
    await screen.findByTestId('interactive-embed-iframe');
    expect(bridge.onEvent).toHaveBeenCalledTimes(1);
    unmount();
    expect(bridge.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
