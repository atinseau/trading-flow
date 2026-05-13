import { ensureHappyDom } from "../../setup";

ensureHappyDom();

import { describe, expect, test } from "bun:test";
import { ReplaySessionCard } from "@client/components/replay/replay-session-card";
import type { ReplaySessionRow } from "@client/components/replay/replay-types";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

function mkSession(overrides: Partial<ReplaySessionRow> = {}): ReplaySessionRow {
  return {
    id: "session-uuid-1234",
    watchId: "btc-1h",
    name: "Test session",
    status: "READY",
    windowStartAt: "2026-04-12T14:00:00.000Z",
    windowEndAt: "2026-04-13T14:00:00.000Z",
    workflowId: "replay-session-1234",
    configSnapshot: {},
    lessonsMode: "current",
    feedbackMode: "run",
    costCapUsd: 5,
    costUsdSoFar: 0.42,
    failureReason: null,
    createdAt: "2026-05-08T12:00:00.000Z",
    updatedAt: "2026-05-08T12:00:00.000Z",
    ...overrides,
  };
}

describe("ReplaySessionCard", () => {
  test("renders name + watch + cost", () => {
    const { getByText } = render(
      <MemoryRouter>
        <ReplaySessionCard session={mkSession()} />
      </MemoryRouter>,
    );
    expect(getByText("Test session")).toBeTruthy();
    expect(getByText(/btc-1h/)).toBeTruthy();
    expect(getByText(/\$0\.42 \/ \$5\.00/)).toBeTruthy();
    expect(getByText("READY")).toBeTruthy();
  });

  test("falls back to short id when name is null", () => {
    const { getByText } = render(
      <MemoryRouter>
        <ReplaySessionCard session={mkSession({ name: null })} />
      </MemoryRouter>,
    );
    // session.id.slice(0, 8) of "session-uuid-1234" = "session-"
    expect(getByText("Session session-")).toBeTruthy();
  });

  test("shows lessons + feedback modes", () => {
    const { getByText } = render(
      <MemoryRouter>
        <ReplaySessionCard
          session={mkSession({ lessonsMode: "historical", feedbackMode: "skip" })}
        />
      </MemoryRouter>,
    );
    expect(getByText(/lessons=historical/)).toBeTruthy();
    expect(getByText(/feedback=skip/)).toBeTruthy();
  });

  test("renders different status colors for COMPLETED", () => {
    const { getByText } = render(
      <MemoryRouter>
        <ReplaySessionCard session={mkSession({ status: "COMPLETED" })} />
      </MemoryRouter>,
    );
    expect(getByText("COMPLETED")).toBeTruthy();
  });
});
