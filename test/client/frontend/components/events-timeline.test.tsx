import { ensureHappyDom } from "../setup";
ensureHappyDom();

import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EventsTimeline } from "@client/components/setup/events-timeline";
import { describe, expect, test } from "bun:test";

const events = [
  {
    id: "e1",
    sequence: 1,
    occurredAt: new Date().toISOString(),
    type: "Strengthened",
    scoreAfter: "67",
    scoreDelta: "12",
    statusBefore: "REVIEWING",
    statusAfter: "REVIEWING",
    payload: {
      type: "Strengthened",
      data: { reasoning: "Hidden reasoning text", observations: [], source: "reviewer_full" },
    },
    provider: "claude_max",
    model: "claude-haiku-4-5",
    costUsd: "0.04",
    latencyMs: 2100,
  },
];

describe("EventsTimeline", () => {
  test("clicking a row reveals reasoning", async () => {
    const { getByText, queryByText } = render(<EventsTimeline events={events} />);
    expect(queryByText("Hidden reasoning text")).toBeNull();
    await userEvent.click(getByText("Strengthened"));
    expect(getByText("Hidden reasoning text")).toBeTruthy();
  });
});
