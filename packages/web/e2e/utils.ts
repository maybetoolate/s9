import { expect, type Page } from '@playwright/test';

/**
 * Shared E2E helpers.
 *
 * Tests drive the real UI. The only state they share is the seeded demo
 * workspace, which `pnpm test:e2e` recreates before the run.
 */

export const SEEDED_EMAIL = 'operator@s9.local';
export const SEEDED_PASSWORD = 's9-demo-password';

/** Builds a name that cannot collide with a previous run or another test. */
export function uniqueName(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Signs in through the real form. */
export async function signIn(
  page: Page,
  email: string = SEEDED_EMAIL,
  password: string = SEEDED_PASSWORD,
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.locator('form button[type="submit"]').click();
}

/**
 * Creates a draft through the creation wizard, using the manual template so the
 * fixture has no dependence on an external provider.
 */
export async function createManualWorkflow(page: Page, name: string): Promise<void> {
  await page.goto('/workflows/new');
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: /Manual trigger/ }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Steps', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

/** Validates and publishes the workflow that is currently open. */
export async function publishWorkflow(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByText('The workflow is valid')).toBeVisible();

  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText(/Version 1 was published/)).toBeVisible();
  await expect(page.getByText('published', { exact: true })).toBeVisible();
}

/**
 * Reloads the execution detail page until the status badge shows `status`.
 *
 * The page is server-rendered and does not poll, so a reload is how a human
 * would observe a run that finishes after the first paint.
 */
export async function waitForExecutionStatus(page: Page, status: string): Promise<void> {
  await expect(async () => {
    await page.reload();
    await expect(page.locator('h1')).toContainText(status);
  }).toPass({ timeout: 30_000, intervals: [500, 1_000, 2_000] });
}
