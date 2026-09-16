import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

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

test("organizer invites a relative, routes a question, and it reaches their sitting", async ({
  page,
  request,
  browser,
}) => {
  await signIn(page, request, "e2e-invite-org@example.com");

  // Create the space.
  await page.getByLabel("Who are we remembering?").fill("Margaret Ellison");
  await page.getByRole("button", { name: /^Create( a)? space$/ }).click();
  await expect(page.getByRole("heading", { name: "Margaret Ellison" })).toBeVisible();

  // Create an invite link and read its one-time URL.
  await page.getByRole("button", { name: "Invite family" }).click();
  await page.getByLabel("Who is this for?").fill("Aunt Carol");
  await page.getByRole("button", { name: "Create an invite link" }).click();
  const inviteUrl = await page.getByLabel("Invite link").inputValue();
  expect(inviteUrl).toContain("/join/");

  // A fresh browser context is the relative: no session, no account.
  const relativeContext = await browser.newContext();
  const relative = await relativeContext.newPage();
  await relative.goto(inviteUrl);
  await expect(
    relative.getByRole("heading", { name: "Help tell Margaret's story." })
  ).toBeVisible();
  await relative.getByLabel("Your name").fill("Carol");
  await relative.getByLabel("You are their").fill("sister");
  await relative.getByRole("button", { name: "Start talking" }).click();

  // The relative lands in the interview with no key or settings surface.
  await expect(relative).toHaveURL(/\/interview/);
  await expect(relative.getByRole("link", { name: "Settings" })).toHaveCount(0);
  await expect(relative.getByRole("button", { name: "Sign out" })).toHaveCount(0);

  // The organizer opens the gap map and routes the first open question to Carol.
  await page.goto("/");
  await page.getByText("Margaret Ellison").click();
  await page.getByRole("link", { name: "What's still open" }).click();
  const firstItem = page.locator(".gap-item").first();
  const questionText = (await firstItem.locator(".gap-text").innerText()).trim();

  await firstItem.getByRole("button", { name: "Send to someone" }).click();
  await firstItem
    .getByLabel("Choose a family member")
    .selectOption({ label: "Carol" });
  await firstItem.getByRole("button", { name: "Send" }).click();
  await expect(firstItem.getByText("Sent to Carol")).toBeVisible();

  // The relative reloads their sitting and sees that question first, under the
  // gentle routed label.
  await relative.reload();
  await expect(
    relative.getByText("Your family thought you might know")
  ).toBeVisible();
  await expect(
    relative.getByRole("heading", { name: questionText })
  ).toBeVisible();

  await relativeContext.close();
});
