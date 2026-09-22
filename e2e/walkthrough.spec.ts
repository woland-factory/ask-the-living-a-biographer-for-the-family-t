import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

test.use({ permissions: ["microphone"] });

const STEP_1 = "Create a space for the person you're remembering.";
const STEP_2 = "Record your first answer in your own voice.";
const STEP_3_KEYLESS =
  "Your first memory is saved. Answer the next question, or step away and come back.";

async function signIn(
  page: Page,
  request: APIRequestContext,
  email: string
): Promise<void> {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a link" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your email" })
  ).toBeVisible();
  const res = await request.get(
    `/auth/dev/last-link?email=${encodeURIComponent(email)}`
  );
  expect(res.ok()).toBeTruthy();
  const { url } = await res.json();
  await page.goto(url);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

async function recordAndStop(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Record your answer" }).click();
  const stop = page.getByRole("button", { name: "Stop" });
  await expect(stop).toBeVisible();
  await expect(page.getByText(/Recording/)).toBeVisible();
  await page.waitForTimeout(900);
  await stop.click();
  await expect(
    page.getByRole("button", { name: "Save this memory" })
  ).toBeVisible();
}

test("leads a fresh organizer create, record, then a final beat that never returns", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    window.__ATL_TRANSCRIBE__ = "stub";
  });
  await signIn(page, request, "e2e-walk@example.com");

  // Step 1 on Home, anchored to the create form.
  await expect(page.getByText(STEP_1)).toBeVisible();

  await page.getByLabel("Who are we remembering?").fill("Rosa Delgado");
  await page.getByRole("button", { name: "Create a space" }).click();

  // Step 2 on the space, anchored to Record a memory.
  await expect(page.getByRole("heading", { name: "Rosa Delgado" })).toBeVisible();
  await expect(page.getByText(STEP_2)).toBeVisible();

  await page.getByRole("link", { name: "Record a memory" }).click();
  // Step 2 also anchors the record control in the interview.
  await expect(page.getByText(STEP_2)).toBeVisible();

  await recordAndStop(page);
  await page.getByRole("button", { name: "Save this memory" }).click();

  // First success: the final beat shows once (keyless, no model key in e2e).
  await expect(page.getByText(STEP_3_KEYLESS)).toBeVisible();
  await expect(page.getByText(STEP_2)).toHaveCount(0);

  // Reload the interview: the beat does not return.
  await page.reload();
  await expect(page.getByText(STEP_3_KEYLESS)).toHaveCount(0);
  await expect(page.getByText(STEP_2)).toHaveCount(0);

  // Home and the space no longer show any walkthrough.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your spaces" })).toBeVisible();
  await expect(page.getByText(STEP_1)).toHaveCount(0);
});

test("an organizer who already has a space never sees the walkthrough", async ({
  page,
  request,
}) => {
  await signIn(page, request, "e2e-walk-existing@example.com");

  // Create a space, which begins the walkthrough for this browser.
  await page.getByLabel("Who are we remembering?").fill("Henry Vale");
  await page.getByRole("button", { name: "Create a space" }).click();
  await expect(page.getByRole("heading", { name: "Henry Vale" })).toBeVisible();

  // Simulate someone who used the app before this shipped: no first-run flag,
  // but a space already present on the very first Home load.
  await page.evaluate(() => {
    localStorage.removeItem("atl:first-run-done");
    localStorage.removeItem("atl:first-run-begun");
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your spaces" })).toBeVisible();
  await expect(page.getByText(STEP_1)).toHaveCount(0);

  // And the space itself shows no step either.
  await page.getByRole("link", { name: "Henry Vale" }).click();
  await expect(page.getByRole("heading", { name: "Henry Vale" })).toBeVisible();
  await expect(page.getByText(STEP_2)).toHaveCount(0);
});

test("Skip on step 1 ends the walkthrough for good", async ({ page, request }) => {
  await signIn(page, request, "e2e-walk-skip@example.com");
  await expect(page.getByText(STEP_1)).toBeVisible();

  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page.getByText(STEP_1)).toHaveCount(0);

  await page.reload();
  await expect(page.getByText(STEP_1)).toHaveCount(0);
});

test("the walkthrough is mobile-clean and keyboard-tappable at 390px", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await signIn(page, request, "e2e-walk-mobile@example.com");
  await expect(page.getByText(STEP_1)).toBeVisible();

  const overflows = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth
  );
  expect(overflows, "horizontal scroll with the walkthrough").toBeFalsy();

  const skip = page.getByRole("button", { name: "Skip" });
  const box = await skip.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
});
