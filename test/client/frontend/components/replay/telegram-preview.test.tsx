import { ensureHappyDom } from "../../setup";

ensureHappyDom();

import { describe, expect, test } from "bun:test";
import { TelegramPreview } from "@client/components/replay/telegram-preview";
import { render } from "@testing-library/react";

describe("TelegramPreview", () => {
  test("renders the message text and a NEUTRALISÉ badge", () => {
    const { getByText } = render(
      <TelegramPreview text="🟢 Setup confirmed: entry 42 350, SL 41 950" />,
    );
    expect(getByText(/Setup confirmed/)).toBeTruthy();
    expect(getByText("NEUTRALISÉ")).toBeTruthy();
  });

  test("preserves whitespace via pre tag", () => {
    const { container } = render(<TelegramPreview text="line 1\nline 2" />);
    const pre = container.querySelector("pre");
    expect(pre).toBeTruthy();
    expect(pre?.textContent).toContain("line 1");
  });
});
