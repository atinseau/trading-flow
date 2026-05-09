import { ensureHappyDom } from "../setup";

ensureHappyDom();

import { describe, expect, test } from "bun:test";
import { TradeOutcomeCard } from "@client/components/setup/trade-outcome-card";
import { render } from "@testing-library/react";

describe("TradeOutcomeCard", () => {
  test("renders nothing when no rMultiple (setup never reached entry)", () => {
    const { container } = render(
      <TradeOutcomeCard
        s={{
          direction: "LONG",
          entryPrice: null,
          stopLoss: null,
          exitPrice: null,
          exitReason: null,
          pnlPct: null,
          rMultiple: null,
          closedAt: null,
          outcome: "REJECTED",
        }}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  test("renders win in emerald with +R", () => {
    const { getByText } = render(
      <TradeOutcomeCard
        s={{
          direction: "LONG",
          entryPrice: "100",
          stopLoss: "90",
          exitPrice: "110",
          exitReason: "TP_HIT",
          pnlPct: "10.0000",
          rMultiple: "1.0000",
          closedAt: null,
          outcome: "WIN",
        }}
      />,
    );
    expect(getByText("+1.00R")).toBeTruthy();
    expect(getByText("+10.00%")).toBeTruthy();
    expect(getByText("TP touché")).toBeTruthy();
  });

  test("renders loss with negative R", () => {
    const { getByText } = render(
      <TradeOutcomeCard
        s={{
          direction: "LONG",
          entryPrice: "100",
          stopLoss: "90",
          exitPrice: "90",
          exitReason: "SL_HIT",
          pnlPct: "-10.0000",
          rMultiple: "-1.0000",
          closedAt: null,
          outcome: "LOSS",
        }}
      />,
    );
    expect(getByText("-1.00R")).toBeTruthy();
    expect(getByText("-10.00%")).toBeTruthy();
    expect(getByText("SL touché")).toBeTruthy();
  });

  test("renders breakeven (0R) without sign confusion", () => {
    const { getByText } = render(
      <TradeOutcomeCard
        s={{
          direction: "LONG",
          entryPrice: "100",
          stopLoss: "90",
          exitPrice: "100",
          exitReason: "SL_HIT",
          pnlPct: "0.0000",
          rMultiple: "0.0000",
          closedAt: null,
          outcome: "PARTIAL_WIN",
        }}
      />,
    );
    expect(getByText("0.00R")).toBeTruthy();
    expect(getByText("0.00%")).toBeTruthy();
  });
});
