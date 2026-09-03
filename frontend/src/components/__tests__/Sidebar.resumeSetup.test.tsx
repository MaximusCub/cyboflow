/**
 * Sidebar "Resume setup" — the label and the click must name the same step.
 *
 * The label used to come from a document.querySelector run inside a memoised
 * render, while the click re-probed the DOM. Nothing re-rendered the Sidebar
 * when the wizard mounted or unmounted, so the button could advertise one step
 * and navigate to another. Both now read navigationStore.view.
 *
 * Mocking mirrors Sidebar.updatePill.test.tsx.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UpdateUiState } from '../../hooks/useUpdater';

// ---------------------------------------------------------------------------
// Mock heavy Sidebar sub-components to keep this test fast and self-contained
// ---------------------------------------------------------------------------

vi.mock('../Settings', () => ({
  Settings: () => null,
}));

vi.mock('../DraggableProjectTreeView', () => ({
  DraggableProjectTreeView: () => <div data-testid="project-tree" />,
}));

vi.mock('../ArchiveProgress', () => ({
  ArchiveProgress: () => null,
}));

vi.mock('../ui/Modal', () => ({
  Modal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ModalHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ModalBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../ui/Button', () => ({
  IconButton: ({ onClick, children, 'aria-label': label }: {
    onClick?: () => void;
    children?: React.ReactNode;
    'aria-label'?: string;
  }) => (
    <button onClick={onClick} aria-label={label}>{children}</button>
  ),
}));

// ---------------------------------------------------------------------------
// useUpdater mock — per-test controllable state + action spies
// ---------------------------------------------------------------------------

const downloadSpy = vi.fn();
const installSpy = vi.fn();
const checkSpy = vi.fn();
const resetSpy = vi.fn();
let mockUpdateState: UpdateUiState = { status: 'idle' };

function setUpdaterState(state: UpdateUiState) {
  mockUpdateState = state;
}

vi.mock('../../hooks/useUpdater', () => ({
  useUpdater: () => ({
    state: mockUpdateState,
    check: checkSpy,
    download: downloadSpy,
    install: installSpy,
    reset: resetSpy,
  }),
}));

// ---------------------------------------------------------------------------
// window.electronAPI mock — mount-time version fetch must resolve a version so
// the bottom version block renders (it is gated on a truthy `version`).
// ---------------------------------------------------------------------------

const mockInvoke = vi.fn();
beforeEach(() => {
  downloadSpy.mockReset();
  installSpy.mockReset();
  checkSpy.mockReset().mockResolvedValue(undefined);
  resetSpy.mockReset();
  mockUpdateState = { status: 'idle' };

  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue({ success: false });
  Object.defineProperty(window, 'electronAPI', {
    writable: true,
    value: {
      invoke: mockInvoke,
      getVersionInfo: () =>
        Promise.resolve({
          success: true,
          data: { current: '1.2.3', gitCommit: 'abcdef1', worktreeName: 'main', variant: 'production' },
        }),
      uiState: {
        getExpanded: () => Promise.resolve({ success: false }),
      },
    },
  });
});

// Import Sidebar after mocks are set up
import React from 'react';
import { Sidebar } from '../Sidebar';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function renderSidebar(onAboutClick: () => void = () => undefined) {
  return render(
    <Sidebar
      onAboutClick={onAboutClick}
      onPromptHistoryClick={() => undefined}
      width={240}
      onResize={() => undefined}
      pendingReviewCount={0}
      humanReviewActive={false}
      onToggleHumanReview={() => undefined}
    />,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------


import { useNavigationStore } from '../../stores/navigationStore';
import { useOnboardingStore } from '../../stores/onboardingStore';

/** Park the tour on a wizard-Configure pointer step, the case that rewinds. */
function parkOnPointerStep(step: number) {
  useOnboardingStore.setState({
    hydrated: true,
    status: 'skipped',
    step,
    maxVisitedStep: step,
    skippedDoSteps: new Set<number>(),
  });
}

describe('Sidebar — Resume setup label and click agree', () => {
  beforeEach(() => {
    useNavigationStore.setState({ view: 'home', wizardOpts: null });
  });

  it('outside the wizard, the label names step 6 and the click rewinds there', async () => {
    parkOnPointerStep(8);
    renderSidebar();

    const button = await screen.findByTestId('onboarding-resume-setup');
    // Step 6 is the 7th of 13, and nothing is skipped in this run.
    expect(button.textContent).toContain('7');
    fireEvent.click(button);

    expect(useOnboardingStore.getState().step).toBe(6);
  });

  it('inside the wizard, the label keeps the step and so does the click', async () => {
    useNavigationStore.setState({ view: 'wizard', wizardOpts: {} });
    parkOnPointerStep(8);
    renderSidebar();

    const button = await screen.findByTestId('onboarding-resume-setup');
    // Step 8 is the 9th of 13.
    expect(button.textContent).toContain('9');
    fireEvent.click(button);

    expect(useOnboardingStore.getState().step).toBe(8);
  });

  it('the label follows a view change without a click in between', async () => {
    parkOnPointerStep(8);
    renderSidebar();

    const button = await screen.findByTestId('onboarding-resume-setup');
    expect(button.textContent).toContain('7');

    // The old DOM probe ran once per render and never re-ran on a mount, so
    // the label went stale exactly here.
    await act(async () => {
      useNavigationStore.setState({ view: 'wizard', wizardOpts: {} });
    });

    expect((await screen.findByTestId('onboarding-resume-setup')).textContent).toContain('9');
  });
});
