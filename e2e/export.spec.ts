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

// The organizer records one memory, then downloads the whole space as a single
// ZIP from the space home. The preparing state shows, a file downloads, and the
// completion card confirms it.
test("organizer downloads the whole space in one action", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    window.__ATL_TRANSCRIBE__ = "stub";
  });
  await signIn(page, request, "e2e-export-org@example.com");

  await page.getByLabel("Who are we remembering?").fill("Rosa Martel");
  await page.getByRole("button", { name: /^Create( a)? space$/ }).click();
  await expect(page.getByRole("heading", { name: "Rosa Martel" })).toBeVisible();
  const spaceUrl = page.url();

  await page.getByRole("link", { name: "Record a memory" }).click();
  await recordSaveAndReturn(page);

  await page.goto(spaceUrl);
  const downloadButton = page.getByRole("button", { name: "Download everything" });
  await expect(downloadButton).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await downloadButton.click();
  // Pressed feedback and the preparing copy appear before the file resolves.
  await expect(
    page.getByText("Gathering every recording and transcript. This can take a moment.")
  ).toBeVisible();

  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.zip$/);

  await expect(
    page.getByText(
      "Saved. Your archive holds every recording, transcript, story, and the map."
    )
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Download again" })).toBeVisible();
});

test("the export action is organizer-only and absent for a contributor", async ({
  page,
  request,
  browser,
}) => {
  await page.addInitScript(() => {
    window.__ATL_TRANSCRIBE__ = "stub";
  });
  await signIn(page, request, "e2e-export-owner@example.com");
  await page.getByLabel("Who are we remembering?").fill("Sam Delgado");
  await page.getByRole("button", { name: /^Create( a)? space$/ }).click();
  await expect(page.getByRole("heading", { name: "Sam Delgado" })).toBeVisible();
  const spaceUrl = page.url();

  // The organizer sees the export action.
  await expect(
    page.getByRole("button", { name: "Download everything" })
  ).toBeVisible();

  // Invite a relative and have them join.
  await page.getByRole("button", { name: "Invite family" }).click();
  await page.getByRole("button", { name: "Create an invite link" }).click();
  const inviteUrl = await page.getByLabel("Invite link").inputValue();

  const relativeContext = await browser.newContext({ permissions: ["microphone"] });
  const relative = await relativeContext.newPage();
  await relative.goto(inviteUrl);
  await relative.getByLabel("Your name").fill("Dana");
  await relative.getByLabel("You are their").fill("child");
  await relative.getByRole("button", { name: "Start talking" }).click();
  await expect(relative).toHaveURL(/\/interview/);

  // The contributor never sees the export action on the space home.
  await relative.goto(spaceUrl);
  await expect(
    relative.getByRole("heading", { name: "Sam Delgado" })
  ).toBeVisible();
  await expect(
    relative.getByRole("button", { name: "Download everything" })
  ).toHaveCount(0);

  // The server enforces it too: the contributor's direct call is refused.
  const spaceUrlParsed = new URL(spaceUrl);
  const spaceId = spaceUrlParsed.pathname.split("/space/")[1];
  const forbidden = await relative.request.get(
    `${spaceUrlParsed.origin}/spaces/${spaceId}/export`
  );
  expect(forbidden.status()).toBe(403);

  await relativeContext.close();
});
