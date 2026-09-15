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

test("a BYOK key can be saved and removed", async ({ page, request }) => {
  await signIn(page, request, "e2e-settings@example.com");

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(
    page.getByRole("heading", { name: "Follow-up questions" })
  ).toBeVisible();

  await page.getByLabel("API key").fill("sk-e2e-dummy-1234");
  await page.getByRole("button", { name: "Save key" }).click();

  // The connected state shows the redacted key, never the full one.
  await expect(page.getByText(/Key ending in 1234/)).toBeVisible();
  await expect(page.getByText("sk-e2e-dummy-1234")).toHaveCount(0);

  await page.getByRole("button", { name: "Remove key" }).click();

  // Back to the form.
  await expect(page.getByRole("button", { name: "Save key" })).toBeVisible();
});
