import { test, expect } from "@playwright/test";
import { mockDesktop } from "./mock";

test("position and time preferences can be disabled independently without erasing old records", async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto("/");
  await page.locator("#demo").click();
  await page.locator('#toc [data-toc="2"]').click();
  await page.locator("#back").click();
  await page.locator("#library-settings").click();
  await expect(page.locator("#remember-position")).toBeChecked();
  await expect(page.locator("#track-reading-time")).toBeChecked();
  await page.locator("#remember-position").uncheck();
  await page.locator("#track-reading-time").uncheck();
  await page.screenshot({ path: "test-results/reading-preferences-off.png" });
  await page.locator("#library-settings-save").click();
  await page.reload();
  await page.locator(".book-card").click();
  await expect(page.frameLocator("#reader").locator("h1")).toHaveText(
    "窗边的一小时",
  );
  await page.locator('#toc [data-toc="3"]').click();
  await page.locator("#back").click();
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("mock.library")!),
  );
  expect(saved.books[0].progress.chapter).toBe(1);
  await page.locator("#library-settings").click();
  await page.locator("#remember-position").check();
  await page.locator("#library-settings-save").click();
  await page.locator(".book-card").click();
  await expect(page.frameLocator("#reader").locator("h1")).toHaveText(
    "散步的意义",
  );
  await page.locator("#library-settings").click();
  await expect(page.locator("#track-reading-time")).not.toBeChecked();
});

test("reading clock excludes background, paused, disabled and sleep intervals, and flushes exact active time", async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto("/");
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.evaluate(async () => {
    const { ReadingClock } = await import("/src/reading-clock.ts");
    const state = { eligible: true, total: 0, calls: [] as number[] };
    const clock = new ReadingClock(
      () => state.eligible,
      async (_token: string, ms: number) => {
        state.total += ms;
        state.calls.push(ms);
      },
    );
    (window as any).clockTest = { clock, state };
    clock.resume("book", true);
  });
  for (let i = 0; i < 3; i++) {
    await page.clock.runFor(1000);
    await page.evaluate(() => (window as any).clockTest.clock.sample());
  }
  await page.evaluate(async () => {
    const { clock, state } = (window as any).clockTest;
    await clock.flush();
    state.eligible = false;
    clock.sample();
  });
  await page.clock.runFor(1000);
  await page.evaluate(async () => {
    const { clock, state } = (window as any).clockTest;
    clock.sample();
    await clock.flush();
    if (state.total !== 3000) throw new Error("Background time counted");
    state.eligible = true;
    clock.sample();
    clock.pause();
  });
  await page.clock.runFor(1000);
  await page.evaluate(async () => {
    const { clock } = (window as any).clockTest;
    await clock.flush();
    clock.resume("book", false);
  });
  await page.clock.runFor(1000);
  await page.evaluate(async () => {
    const { clock } = (window as any).clockTest;
    await clock.flush();
    clock.preference(true);
  });
  await page.clock.runFor(10000);
  await page.evaluate(async () => {
    const { clock } = (window as any).clockTest;
    clock.sample();
    await clock.flush();
  });
  expect(await page.evaluate(() => (window as any).clockTest.state.total)).toBe(
    3000,
  );
  await page.clock.runFor(1000);
  await page.evaluate(async () => {
    const { clock } = (window as any).clockTest;
    clock.sample();
    await clock.flush();
  });
  expect(await page.evaluate(() => (window as any).clockTest.state.total)).toBe(
    4000,
  );
});

test("foreground reader persists time, info shows it, and disabling stops accumulation in the current book", async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto("/");
  await page.locator("#demo").click();
  await expect(page.locator("#chapter-loading")).toBeHidden();
  await page
    .frameLocator("#reader")
    .locator("body")
    .click({ position: { x: 20, y: 20 } });
  await page.waitForTimeout(2200);
  await page.locator("#book-info").click();
  await expect(page.locator("#book-info-content")).toContainText(
    "累计阅读时长",
  );
  const total = () =>
    page.evaluate(() =>
      Object.values(
        JSON.parse(localStorage.getItem("mock.library")!).reading_ms || {},
      ).reduce((sum: number, n) => sum + Number(n), 0),
    );
  expect(await total()).toBeGreaterThanOrEqual(1000);
  await page.locator("#book-info-close").click();
  await page.locator("#library-settings").click();
  await page.locator("#track-reading-time").uncheck();
  await page.locator("#library-settings-save").click();
  await expect(page.locator("#library-settings-dialog")).toBeHidden();
  const stopped = await total();
  await page
    .frameLocator("#reader")
    .locator("body")
    .click({ position: { x: 20, y: 20 } });
  await page.waitForTimeout(2200);
  await page.locator("#book-info").click();
  await expect(page.locator("#book-info-content")).toContainText(
    "累计阅读时长",
  );
  expect(await total()).toBe(stopped);
});
