import { expect, test } from "@playwright/test";

// The one flow no unit test can exercise (issue #93): a real browser's
// service worker lifecycle. Five rounds of code-level fixes each looked
// correct in isolation and still failed against a real browser — the install
// silently rejecting (`cache.addAll`'s all-or-nothing behavior) never showed
// up as a non-200 anywhere, and the only real signature was
// `navigator.serviceWorker.controller` staying null after a normal reload.
// This asserts the actual thing that matters: the worker reaches "activated"
// and controls the page, and an offline reload still renders the app shell
// instead of a white screen.
test("service worker activates and controls the page, and an offline reload still renders the shell", async ({
  page,
  context,
}) => {
  await page.goto("/");

  // clients.claim() (sw.ts's activate handler) claims the very page that
  // triggered registration, so this should go non-null without needing a
  // second navigation — but only once install has actually succeeded.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 20_000,
  });
  const controlled = await page.evaluate(() => navigator.serviceWorker.controller !== null);
  expect(controlled).toBe(true);

  await context.setOffline(true);
  await page.reload();

  // Not a specific string — this must hold regardless of auth/session state
  // (signed out renders the login form; signed in with a saved shopping list
  // renders that instead). The one thing that must never happen offline is a
  // blank #root, i.e. the browser's own offline error page.
  await expect(page.locator("#root")).not.toBeEmpty();
});
