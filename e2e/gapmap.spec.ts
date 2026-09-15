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

test("the gap map lists open questions and the open count shrinks on resolve", async ({
  page,
  request,
}) => {
  await signIn(page, request, "e2e-gapmap@example.com");

  await page.getByLabel("Who are we remembering?").fill("Margaret Ellison");
  await page.getByRole("button", { name: /^Create( a)? space$/ }).click();
  await expect(page.getByRole("heading", { name: "Margaret Ellison" })).toBeVisible();

  await page.getByRole("link", { name: "What's still open" }).click();

  // The seeded bank opens the map with sixteen questions.
  await expect(page.getByRole("heading", { name: "16 still open" })).toBeVisible();

  await page.getByRole("button", { name: "Mark answered" }).first().click();

  // The open count drops as a question resolves.
  await expect(page.getByRole("heading", { name: "15 still open" })).toBeVisible();
});
