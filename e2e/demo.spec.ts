import { test, expect } from "@playwright/test";

// A signed-out first-time visitor reaches the seeded side-by-side moment from
// the landing page, with no key and no input.
test("the landing 'See how it works' link opens the seeded side-by-side", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "See how it works" }).click();
  await expect(page).toHaveURL(/\/demo$/);

  // The seeded story renders two tellings side by side.
  await expect(
    page.getByRole("heading", { name: "The bakery on Sunday mornings" })
  ).toBeVisible();
  await expect(page.locator(".sbs-column")).toHaveCount(2);

  // Each telling carries the one question the other's telling opened.
  await expect(
    page.getByText("A question the other telling opened").first()
  ).toBeVisible();
  await expect(
    page.getByText("What songs did Rosa sing while the bread baked?")
  ).toBeVisible();
  await expect(
    page.getByText("Who was the neighbor your mother saved the first loaf for?")
  ).toBeVisible();
});

test("the demo has no horizontal scroll at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/demo");
  await expect(
    page.getByRole("heading", { name: "The bakery on Sunday mornings" })
  ).toBeVisible();
  const overflows = await page.evaluate(
    () =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  expect(overflows, "horizontal scroll on demo").toBeFalsy();
});
