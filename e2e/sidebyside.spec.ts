import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

test.use({ permissions: ["microphone"] });

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
  const { url } = await res.json();
  await page.goto(url);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

async function recordSaveAndReturn(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Record your answer" }).click();
  const stop = page.getByRole("button", { name: "Stop" });
  await expect(stop).toBeVisible();
  await page.waitForTimeout(900);
  await stop.click();
  await page.getByRole("button", { name: "Save this memory" }).click();
  await expect(
    page.getByRole("heading", { name: "Saved this sitting" })
  ).toBeVisible();
}

// The no-key manual grouping path: two people's tellings land side by side
// without any model key.
test("group two tellings by hand and see them side by side", async ({
  page,
  request,
  browser,
}) => {
  await page.addInitScript(() => {
    window.__ATL_TRANSCRIBE__ = "stub";
  });
  await signIn(page, request, "e2e-sbs-org@example.com");

  // The organizer records one telling.
  await page.getByLabel("Who are we remembering?").fill("Rosa Martel");
  await page.getByRole("button", { name: /^Create( a)? space$/ }).click();
  await expect(page.getByRole("heading", { name: "Rosa Martel" })).toBeVisible();
  const spaceUrl = page.url();
  await page.getByRole("link", { name: "Record a memory" }).click();
  await recordSaveAndReturn(page);

  // A relative joins and records their own telling.
  await page.goto(spaceUrl);
  await page.getByRole("button", { name: "Invite family" }).click();
  await page.getByRole("button", { name: "Create an invite link" }).click();
  const inviteUrl = await page.getByLabel("Invite link").inputValue();

  const relativeContext = await browser.newContext({ permissions: ["microphone"] });
  const relative = await relativeContext.newPage();
  await relative.addInitScript(() => {
    window.__ATL_TRANSCRIBE__ = "stub";
  });
  await relative.goto(inviteUrl);
  await relative.getByLabel("Your name").fill("Elena");
  await relative.getByLabel("You are their").fill("sister");
  await relative.getByRole("button", { name: "Start talking" }).click();
  await expect(relative).toHaveURL(/\/interview/);
  await recordSaveAndReturn(relative);
  await relativeContext.close();

  // The organizer groups both tellings into one story.
  await page.goto(spaceUrl);
  await page.getByRole("link", { name: "See tellings side by side" }).click();
  await expect(page.getByRole("heading", { name: "Stories" })).toBeVisible();

  // Two untagged tellings to start (one placeholder option plus two tellings).
  const tellingSelect = page.getByLabel("Choose a telling");
  await expect(tellingSelect.locator("option")).toHaveCount(3);

  // First telling into a new story.
  await tellingSelect.selectOption({ index: 1 });
  await page.getByLabel("Choose a story").selectOption({ label: "Start a new story" });
  await page.getByLabel("New story name").fill("The bakery");
  await page.getByRole("button", { name: "Add to story" }).click();

  // The tagged telling leaves the picker once the list reloads. Only then
  // choose the remaining one, so the two tellings land in the same story.
  await expect(tellingSelect.locator("option")).toHaveCount(2);
  await tellingSelect.selectOption({ index: 1 });
  await page.getByLabel("Choose a story").selectOption({ label: "The bakery" });
  await page.getByRole("button", { name: "Add to story" }).click();

  // The story is ready with two tellers. Open it and see two columns.
  await expect(page.getByText("Ready side by side")).toBeVisible();
  await page.getByRole("link", { name: /The bakery/ }).click();
  await expect(
    page.getByRole("heading", { name: "The bakery" })
  ).toBeVisible();
  await expect(page.locator(".sbs-column")).toHaveCount(2);
});

test("stories page has no horizontal scroll at 390px", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await signIn(page, request, "e2e-sbs-mobile@example.com");
  await page.getByLabel("Who are we remembering?").fill("Sam Delgado");
  await page.getByRole("button", { name: /^Create( a)? space$/ }).click();
  await expect(page.getByRole("heading", { name: "Sam Delgado" })).toBeVisible();
  await page.getByRole("link", { name: "See tellings side by side" }).click();
  await expect(page.getByRole("heading", { name: "Stories" })).toBeVisible();
  const overflows = await page.evaluate(
    () =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  expect(overflows, "horizontal scroll on stories").toBeFalsy();
});
