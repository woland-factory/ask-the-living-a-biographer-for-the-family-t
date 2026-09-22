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
  expect(res.ok()).toBeTruthy();
  const { url } = await res.json();
  await page.goto(url);
  // Signed in on the home screen (new users and returning users alike).
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

async function createSpaceAndOpenInterview(page: Page, name: string): Promise<void> {
  await page.getByLabel("Who are we remembering?").fill(name);
  // "Create a space" on a first space, "Create space" on later ones.
  await page.getByRole("button", { name: /^Create( a)? space$/ }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await page.getByRole("link", { name: "Record a memory" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Where did they grow up, and what was the house like?",
    })
  ).toBeVisible();
}

async function recordAndStop(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Record your answer" }).click();
  const stop = page.getByRole("button", { name: "Stop" });
  await expect(stop).toBeVisible();
  // Let the fake device produce a moment of audio before stopping.
  await expect(page.getByText(/Recording/)).toBeVisible();
  await page.waitForTimeout(900);
  await stop.click();
  await expect(
    page.getByRole("button", { name: "Save this memory" })
  ).toBeVisible();
}

test("records, saves, transcribes, and resumes without re-asking", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    window.__ATL_TRANSCRIBE__ = "stub";
  });
  await signIn(page, request, "e2e-record@example.com");
  await createSpaceAndOpenInterview(page, "Margaret Ellison");

  await recordAndStop(page);
  await page.getByRole("button", { name: "Save this memory" }).click();

  // Saved and shown in this sitting, with the stubbed transcript attached.
  await expect(
    page.getByRole("heading", { name: "Saved this sitting" })
  ).toBeVisible();
  await expect(
    page.getByText("A short remembered story, saved with the recording.")
  ).toBeVisible();

  // The interview advanced to the next question.
  await expect(
    page.getByRole("heading", {
      name: "What is a story they told about their own childhood?",
    })
  ).toBeVisible();

  // Reloading resumes at the right question; the answered one is not re-asked.
  await page.reload();
  await expect(
    page.getByRole("heading", {
      name: "What is a story they told about their own childhood?",
    })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Where did they grow up, and what was the house like?",
    })
  ).toHaveCount(0);
});

test("a failed transcription keeps the recording and offers a gentle retry", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    window.__ATL_TRANSCRIBE__ = "fail";
  });
  await signIn(page, request, "e2e-fail@example.com");
  await createSpaceAndOpenInterview(page, "Henry Okafor");

  await recordAndStop(page);
  await page.getByRole("button", { name: "Save this memory" }).click();

  await expect(
    page.getByText("Your recording is saved. The written copy didn't come through.")
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Try transcribing again" })
  ).toBeVisible();
  // The recording itself is still present.
  await expect(page.locator("audio").first()).toBeVisible();
});

test("deferring a topic moves to a question from a different topic", async ({
  page,
  request,
}) => {
  await signIn(page, request, "e2e-defer@example.com");
  await createSpaceAndOpenInterview(page, "Rosa Martel");

  await page.getByRole("button", { name: "Not this topic yet" }).click();

  await expect(
    page.getByRole("heading", {
      name: "How did they meet the people they built a family with?",
    })
  ).toBeVisible();
  await expect(page.getByText("Family", { exact: true })).toBeVisible();
});

test("a completed sitting shows a success surface with no funnel", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    window.__ATL_TRANSCRIBE__ = "stub";
  });
  await signIn(page, request, "e2e-complete@example.com");
  await createSpaceAndOpenInterview(page, "Alice Brenner");

  await recordAndStop(page);
  await page.getByRole("button", { name: "Save this memory" }).click();
  await expect(
    page.getByRole("heading", { name: "Saved this sitting" })
  ).toBeVisible();

  await page.getByRole("button", { name: "I'm done for now" }).click();

  await expect(
    page.getByRole("heading", { name: "You gave them your voice today." })
  ).toBeVisible();
  await expect(page.getByText(/of Alice this sitting/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Record another" })).toBeVisible();
  // No "X of Y" funnel framing anywhere on the surface.
  await expect(page.getByText(/\d+\s+of\s+\d+/)).toHaveCount(0);
});

test("interview screen has no horizontal scroll at 390px", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await signIn(page, request, "e2e-mobile@example.com");
  await createSpaceAndOpenInterview(page, "Sam Delgado");

  const overflows = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth
  );
  expect(overflows, "horizontal scroll on interview").toBeFalsy();

  const record = page.getByRole("button", { name: "Record your answer" });
  await expect(record).toBeVisible();
  await expect
    .poll(async () => (await record.boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(44);
});
