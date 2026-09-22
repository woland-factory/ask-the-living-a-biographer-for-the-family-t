import { test, expect } from "@playwright/test";

test("first paint shows real content, not a blank page", async ({ page }) => {
  await page.goto("/", { waitUntil: "commit" });
  await expect(
    page.getByRole("heading", { name: "Remember them together." })
  ).toBeVisible();
});

test("an expired sign-in link shows a designed, calm message", async ({
  page,
}) => {
  await page.goto("/signin?e=expired");
  await expect(
    page.getByText("That link has expired. Ask for a new one.")
  ).toBeVisible();
});

test("no horizontal scroll and tappable actions at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });

  for (const path of ["/", "/signin"]) {
    await page.goto(path);
    const overflows = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth
    );
    expect(overflows, `horizontal scroll on ${path}`).toBeFalsy();
  }

  const button = page.getByRole("button", { name: "Email me a link" });
  await expect(button).toBeVisible();
  // Poll the height so a first paint before the CSS bundle applies over the
  // inline critical CSS settles instead of failing on a transient measurement.
  await expect
    .poll(async () => (await button.boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(44);
});
