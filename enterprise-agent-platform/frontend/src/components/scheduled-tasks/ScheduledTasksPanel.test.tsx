// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCALE_STORAGE_KEY } from "../../i18n";
import { TestUiProviders } from "../../test/TestUiProviders";
import type { AgentSchedule, AgentScheduleRun } from "../../types";
import { ScheduledTasksPanel } from "./ScheduledTasksPanel";

const mocks = vi.hoisted(() => ({
  loadAgentSchedules: vi.fn(),
  loadAgentSchedule: vi.fn(),
  loadAgentScheduleRuns: vi.fn(),
  pauseAgentSchedule: vi.fn(),
  resumeAgentSchedule: vi.fn(),
  runAgentScheduleNow: vi.fn(),
  deleteAgentSchedule: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../../data/scheduleActions", () => ({
  loadAgentSchedules: mocks.loadAgentSchedules,
  loadAgentSchedule: mocks.loadAgentSchedule,
  loadAgentScheduleRuns: mocks.loadAgentScheduleRuns,
  pauseAgentSchedule: mocks.pauseAgentSchedule,
  resumeAgentSchedule: mocks.resumeAgentSchedule,
  runAgentScheduleNow: mocks.runAgentScheduleNow,
  deleteAgentSchedule: mocks.deleteAgentSchedule,
}));

vi.mock("../../context/ToastContext", () => ({ toast: mocks.toast }));

const run: AgentScheduleRun = {
  id: 31,
  schedule_id: 9,
  scheduled_for: "2026-07-16T09:00:00Z",
  status: "succeeded",
  source_message_id: 100,
  response_message_id: 101,
  started_at: "2026-07-16T09:00:01Z",
  finished_at: "2026-07-16T09:00:03Z",
  error: "",
};

const schedule: AgentSchedule = {
  id: 9,
  name: "Morning brief",
  prompt: "Summarize the latest project updates.",
  schedule: { type: "cron", expression: "0 9 * * 1-5" },
  timezone: "UTC",
  delivery: "chat",
  state: "active",
  enabled: true,
  next_run_at: "2026-07-17T09:00:00Z",
  last_run: run,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-16T09:00:03Z",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderPanel() {
  return render(<TestUiProviders><ScheduledTasksPanel /></TestUiProviders>);
}

describe("ScheduledTasksPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    mocks.loadAgentSchedules.mockResolvedValue({ schedules: [schedule] });
    mocks.loadAgentSchedule.mockResolvedValue({ schedule });
    mocks.loadAgentScheduleRuns.mockResolvedValue({ runs: [run], next_before_id: null });
    mocks.pauseAgentSchedule.mockResolvedValue({
      schedule: { ...schedule, state: "paused", enabled: false },
    });
    mocks.resumeAgentSchedule.mockResolvedValue({ schedule });
    mocks.runAgentScheduleNow.mockResolvedValue({
      schedule: { ...schedule, last_run: { ...run, id: 32, status: "queued" } },
      run: { ...run, id: 32, status: "queued" },
    });
    mocks.deleteAgentSchedule.mockResolvedValue({ deleted: true, id: schedule.id });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("renders server-created tasks and offers management without create or edit controls", async () => {
    renderPanel();

    expect(await screen.findByRole("heading", { name: "Morning brief" })).toBeVisible();
    expect(screen.getByText("Cron · 0 9 * * 1-5")).toBeVisible();
    expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Run now" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /create|edit/i })).not.toBeInTheDocument();
  });

  it("pauses a task and replaces the card with the returned server state", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByRole("heading", { name: "Morning brief" });

    await user.click(screen.getByRole("button", { name: "Pause" }));

    expect(mocks.pauseAgentSchedule).toHaveBeenCalledWith(9);
    expect(await screen.findByText("Paused")).toBeVisible();
    expect(screen.getByRole("button", { name: "Resume" })).toBeEnabled();
  });

  it("does not let an older list refresh overwrite a newer pause response", async () => {
    const user = userEvent.setup();
    const staleRefresh = deferred<{ schedules: AgentSchedule[] }>();
    renderPanel();
    await screen.findByRole("heading", { name: "Morning brief" });
    mocks.loadAgentSchedules.mockReturnValueOnce(staleRefresh.promise);

    await user.click(screen.getByRole("button", { name: "Refresh tasks" }));
    const staleCalls = mocks.loadAgentSchedules.mock.calls;
    const staleSignal = staleCalls[staleCalls.length - 1]?.[0] as AbortSignal;
    await user.click(screen.getByRole("button", { name: "Pause" }));

    expect(await screen.findByText("Paused")).toBeVisible();
    expect(staleSignal.aborted).toBe(true);
    await act(async () => staleRefresh.resolve({ schedules: [schedule] }));
    expect(screen.getByText("Paused")).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh tasks" })).toBeEnabled();
  });

  it("does not let an older detail refresh overwrite a newer pause response", async () => {
    const user = userEvent.setup();
    const staleDetail = deferred<{ schedule: AgentSchedule }>();
    renderPanel();
    await screen.findByRole("heading", { name: "Morning brief" });
    await user.click(screen.getByRole("button", { name: "Run history" }));
    await screen.findByText("Run history for “Morning brief”");
    mocks.loadAgentSchedule.mockReturnValueOnce(staleDetail.promise);

    await user.click(screen.getByRole("button", { name: "Refresh run history" }));
    const detailCalls = mocks.loadAgentSchedule.mock.calls;
    const staleSignal = detailCalls[detailCalls.length - 1]?.[1] as AbortSignal;
    await user.click(screen.getByRole("button", { name: "Pause" }));

    expect(await screen.findByText("Paused")).toBeVisible();
    expect(staleSignal.aborted).toBe(true);
    await act(async () => staleDetail.resolve({ schedule }));
    await waitFor(() => expect(screen.getByText("Paused")).toBeVisible());
  });

  it("does not let an older list refresh restore a deleted task", async () => {
    const user = userEvent.setup();
    const staleRefresh = deferred<{ schedules: AgentSchedule[] }>();
    renderPanel();
    await screen.findByRole("heading", { name: "Morning brief" });
    mocks.loadAgentSchedules.mockReturnValueOnce(staleRefresh.promise);

    await user.click(screen.getByRole("button", { name: "Refresh tasks" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: "Delete scheduled task?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(screen.queryByRole("heading", { name: "Morning brief" })).not.toBeInTheDocument();

    await act(async () => staleRefresh.resolve({ schedules: [schedule] }));
    expect(screen.queryByRole("heading", { name: "Morning brief" })).not.toBeInTheDocument();
  });

  it("confirms run-now and delete operations before calling their endpoints", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByRole("heading", { name: "Morning brief" });

    await user.click(screen.getByRole("button", { name: "Run now" }));
    let dialog = screen.getByRole("dialog", { name: "Run task now?" });
    await user.click(within(dialog).getByRole("button", { name: "Run now" }));
    expect(mocks.runAgentScheduleNow).toHaveBeenCalledWith(9);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    dialog = screen.getByRole("dialog", { name: "Delete scheduled task?" });
    expect(within(dialog).getByText(
      "Deleting “Morning brief” stops future scheduled triggers and cannot be undone. Runs that are already queued or in progress may still complete.",
    )).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(mocks.deleteAgentSchedule).toHaveBeenCalledWith(9);
    expect(screen.queryByRole("heading", { name: "Morning brief" })).not.toBeInTheDocument();
  });

  it("loads task detail and paginated run history only when history opens", async () => {
    const user = userEvent.setup();
    const older = { ...run, id: 20, status: "failed", error: "network unavailable" };
    mocks.loadAgentScheduleRuns
      .mockResolvedValueOnce({ runs: [run], next_before_id: 31 })
      .mockResolvedValueOnce({ runs: [older], next_before_id: null });
    renderPanel();
    await screen.findByRole("heading", { name: "Morning brief" });
    expect(mocks.loadAgentSchedule).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Run history" }));
    expect(await screen.findByText("Run history for “Morning brief”")).toBeVisible();
    expect(mocks.loadAgentSchedule).toHaveBeenCalledWith(9, expect.any(AbortSignal));
    expect(screen.getByText("Succeeded")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("network unavailable")).toBeVisible();
    expect(mocks.loadAgentScheduleRuns).toHaveBeenLastCalledWith(9, 20, 31, expect.any(AbortSignal));
  });

  it("aborts a delayed page and never mixes schedule A history into schedule B", async () => {
    const user = userEvent.setup();
    const delayedPage = deferred<{ runs: AgentScheduleRun[]; next_before_id: number | null }>();
    const eveningRun: AgentScheduleRun = {
      ...run,
      id: 41,
      schedule_id: 10,
      error: "Evening record",
    };
    const eveningSchedule: AgentSchedule = {
      ...schedule,
      id: 10,
      name: "Evening review",
      last_run: eveningRun,
    };
    const delayedMorningRun: AgentScheduleRun = {
      ...run,
      id: 20,
      error: "Delayed morning record",
    };
    mocks.loadAgentSchedules.mockResolvedValue({ schedules: [schedule, eveningSchedule] });
    mocks.loadAgentSchedule.mockImplementation((id: number) => Promise.resolve({
      schedule: id === eveningSchedule.id ? eveningSchedule : schedule,
    }));
    mocks.loadAgentScheduleRuns.mockImplementation((id: number, _limit: number, beforeId?: number) => {
      if (id === schedule.id && beforeId === run.id) return delayedPage.promise;
      if (id === schedule.id) return Promise.resolve({ runs: [run], next_before_id: run.id });
      return Promise.resolve({ runs: [eveningRun], next_before_id: null });
    });

    renderPanel();
    const morningHeading = await screen.findByRole("heading", { name: "Morning brief" });
    await user.click(within(morningHeading.closest("article")!).getByRole("button", { name: "Run history" }));
    await screen.findByText("Run history for “Morning brief”");
    await user.click(screen.getByRole("button", { name: "Load more" }));
    const delayedCall = mocks.loadAgentScheduleRuns.mock.calls.find(
      (call) => call[0] === schedule.id && call[2] === run.id,
    );
    const delayedSignal = delayedCall?.[3] as AbortSignal;

    await user.click(screen.getByRole("button", { name: "Back to tasks" }));
    const eveningHeading = await screen.findByRole("heading", { name: "Evening review" });
    await user.click(within(eveningHeading.closest("article")!).getByRole("button", { name: "Run history" }));
    expect(await screen.findByText("Run history for “Evening review”")).toBeVisible();
    expect(screen.getByText("Evening record")).toBeVisible();
    expect(delayedSignal.aborted).toBe(true);

    await act(async () => delayedPage.resolve({ runs: [delayedMorningRun], next_before_id: null }));
    await waitFor(() => expect(screen.queryByText("Delayed morning record")).not.toBeInTheDocument());
    expect(screen.getByText("Evening record")).toBeVisible();
  });

  it("aborts a delayed history page when the panel unmounts", async () => {
    const user = userEvent.setup();
    const delayedPage = deferred<{ runs: AgentScheduleRun[]; next_before_id: number | null }>();
    mocks.loadAgentScheduleRuns
      .mockResolvedValueOnce({ runs: [run], next_before_id: run.id })
      .mockReturnValueOnce(delayedPage.promise);
    const view = renderPanel();
    await screen.findByRole("heading", { name: "Morning brief" });
    await user.click(screen.getByRole("button", { name: "Run history" }));
    await screen.findByText("Run history for “Morning brief”");
    await user.click(screen.getByRole("button", { name: "Load more" }));
    const runCalls = mocks.loadAgentScheduleRuns.mock.calls;
    const delayedSignal = runCalls[runCalls.length - 1]?.[3] as AbortSignal;

    view.unmount();
    expect(delayedSignal.aborted).toBe(true);
    await act(async () => delayedPage.resolve({ runs: [], next_before_id: null }));
  });

  it("shows the empty state without inventing a creation form", async () => {
    mocks.loadAgentSchedules.mockResolvedValue({ schedules: [] });
    renderPanel();
    expect(await screen.findByText("No scheduled tasks yet")).toBeVisible();
    expect(screen.getByText("Ask your Private Agent in the conversation to create one.")).toBeVisible();
  });
});
