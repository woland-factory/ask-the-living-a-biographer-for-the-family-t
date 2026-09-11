import { test, expect } from "@playwright/test";

test("organizer signs in and creates their first space", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Remember them together." })
  ).toBeVisible();

  await page.getByRole("link", { name: "Create a space" }).click();
  await expect(page).toHaveURL(/\/signin/);

  const email = "e2e-organizer@example.com";
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a link" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your email" })
  ).toBeVisible();

  // Take the link the Mailer stub would have sent (e2e-only endpoint).
  const res = await request.get(
    `/auth/dev/last-link?email=${encodeURIComponent(email)}`
  );
  expect(res.ok()).toBeTruthy();
  const { url } = await res.json();

  await page.goto(url);
  // Verified and redirected to the signed-in empty state.
  await expect(
    page.getByRole("heading", { name: "Create your first space" })
  ).toBeVisible();

  await page.getByLabel("Who are we remembering?").fill("Margaret Ellison");
  await page.getByLabel("Birth year").fill("1949");
  await page.getByLabel("Death year").fill("2026");
  await page.getByRole("button", { name: "Create a space" }).click();

  await expect(
    page.getByRole("heading", { name: "Margaret Ellison" })
  ).toBeVisible();
  await expect(page.getByText("1949 to 2026")).toBeVisible();

  // A hard refresh of the space page shows the app, not raw API JSON.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Margaret Ellison" })
  ).toBeVisible();

  // The space is now listed on home.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your spaces" })).toBeVisible();
  await expect(page.getByText("Margaret Ellison")).toBeVisible();
});
