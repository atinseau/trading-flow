import { describe, test } from "bun:test";
import { chromium, expect } from "playwright/test";

const URL = process.env.TF_WEB_URL ?? "http://localhost:8084";
const RUN = process.env.RUN_E2E === "1";

const maybe = RUN ? describe : describe.skip;

maybe("tf-web e2e smoke", () => {
  test("loads dashboard, creates a watch via UI", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
      await page.goto(URL, { waitUntil: "networkidle" });

      // Dashboard heading visible
      await expect(page.getByText(/dashboard|watches/i).first()).toBeVisible();

      // Click "Nouvelle watch" or "Créer la première watch"
      await page
        .getByRole("link", { name: /nouvelle watch|créer la première watch/i })
        .first()
        .click();

      // Fill the form — minimal required fields
      const wid = `e2e-${Date.now()}`;
      await page.fill('input[name="id"]', wid);
      await page.fill('input[name="asset.symbol"]', "BTCUSDT");

      // Asset source select — open and choose binance
      const sourceTrigger = page.getByRole("combobox").first();
      await sourceTrigger.click();
      await page.getByRole("option", { name: /binance/i }).click();

      // Submit
      await page.getByRole("button", { name: /créer la watch/i }).click();

      // Should navigate to /watches/<id>
      await page.waitForURL(/\/watches\//, { timeout: 10_000 });
      await expect(page.getByText(new RegExp(`watch — ${wid}`, "i"))).toBeVisible();
    } finally {
      await browser.close();
    }
  }, 60_000);
});
