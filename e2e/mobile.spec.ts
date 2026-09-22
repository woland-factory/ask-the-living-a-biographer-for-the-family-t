import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

// A 390px sweep across every route: no horizontal scroll, a real top-level
// heading, and a tappable primary action at least 44px tall.

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

async function assertMobileClean(page: Page, label: string): Promise<void> {
  // A top-level heading is present (waits out any loading skeleton).
  await expect(
    page.getByRole("heading", { level: 1 }).first(),
    `top-level heading on ${label}`
  ).toBeVisible();

  const overflows = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth
  );
  expect(overflows, `horizontal scroll on ${label}`).toBeFalsy();

  const primary = page.locator(".btn-primary");
  const target = (await primary.count())
    ? primary.first()
    : page.locator(".btn").first();
  await expect(target, `primary action present on ${label}`).toBeVisible();
  // Poll so a first paint before the CSS bundle applies settles rather than
  // failing on a transient unstyled measurement.
  await expect
    .poll(async () => (await target.boundingBox())?.height ?? 0, {
      message: `primary action at least 44px on ${label}`,
    })
    .toBeGreaterThanOrEqual(44);
}

test("every screen holds at 390px", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  // Hide the first-run walkthrough so each screen is checked in its own right.
  await page.addInitScript(() => {
    try {
      localStorage.setItem("atl:first-run-done", "1");
    } catch {
      /* private mode: the walkthrough simply stays visible and is harmless */
    }
  });

  // Public routes, no account needed.
  for (const path of ["/", "/signin", "/demo"]) {
    await page.goto(path);
    await assertMobileClean(page, path);
  }

  // Signed-in organizer with a space to reach the rest of the app.
  await signIn(page, request, "e2e-mobile-sweep@example.com");
  await page.getByLabel("Who are we remembering?").fill("Rosa Martel");
  await page.getByRole("button", { name: "Create a space" }).click();
  await expect(page.getByRole("heading", { name: "Rosa Martel" })).toBeVisible();
  const spaceId = page.url().split("/space/")[1];

  const authed: Array<[string, string]> = [
    ["/", "home"],
    [`/space/${spaceId}`, "space detail"],
    [`/space/${spaceId}/interview`, "interview"],
    [`/space/${spaceId}/questions`, "gap map"],
    [`/space/${spaceId}/stories`, "stories"],
    [
      `/space/${spaceId}/story/00000000-0000-0000-0000-000000000000`,
      "side by side",
    ],
    ["/settings", "settings"],
  ];
  for (const [path, label] of authed) {
    await page.goto(path);
    await assertMobileClean(page, label);
  }

  // Join: a real invite token, as a first-time relative sees it.
  const res = await page.request.post(`/spaces/${spaceId}/invites`, {
    data: {},
  });
  expect(res.ok()).toBeTruthy();
  const token = new URL((await res.json()).url).pathname.split("/join/")[1];
  await page.goto(`/join/${token}`);
  await assertMobileClean(page, "join");
});
