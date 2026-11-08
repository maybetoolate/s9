import { expect, test, type Page } from '@playwright/test';
import {
  createManualWorkflow,
  publishWorkflow,
  uniqueName,
  waitForExecutionStatus,
} from './utils';

/**
 * Executions.
 *
 * These tests exercise the full pipeline: the UI creates and publishes a
 * workflow, the API writes an execution, the worker runs it, and the execution
 * page renders the persisted result.
 */

/** Runs the open, published workflow with the given trigger input. */
async function runNow(page: Page, input: Record<string, unknown>): Promise<void> {
  await page.getByRole('button', { name: 'Run now' }).click();

  const dialog = page.getByRole('dialog', { name: 'Run now' });
  await dialog.locator('textarea').fill(JSON.stringify(input));
  await dialog.getByRole('button', { name: 'Run now' }).click();

  await expect(page).toHaveURL(/\/executions\/[0-9a-f-]{36}$/);
}

test.describe('executions', () => {
  test('runs a published workflow and records every step', async ({ page }) => {
    const name = uniqueName('E2E Run');
    const email = `e2e-${Date.now().toString(36)}@example.com`;

    await createManualWorkflow(page, name);
    await publishWorkflow(page);

    await runNow(page, { name: 'E2E User', email });

    await waitForExecutionStatus(page, 'succeeded');

    await expect(page.getByRole('heading', { name })).toBeVisible();
    await page.getByRole('tab', { name: 'Steps' }).click();
    await expect(page.getByText(/1\. Save contact/)).toBeVisible();
    await expect(page.getByText('succeeded', { exact: true }).first()).toBeVisible();

    // The run is visible in the history and can be filtered by status.
    await page.goto('/executions');
    await expect(page.getByRole('link', { name })).toBeVisible();

    await page.locator('select[name="status"]').selectOption('succeeded');
    await page.getByRole('button', { name: 'Filter' }).click();
    await expect(page).toHaveURL(/status=succeeded/);
    await expect(page.getByRole('link', { name })).toBeVisible();
    await expect(page.getByText('succeeded', { exact: true }).first()).toBeVisible();
  });

  test('runs a draft as a test execution without touching the published version', async ({ page }) => {
    const name = uniqueName('E2E Test Run');

    await createManualWorkflow(page, name);

    // A draft has no published version, so only the test run is available.
    await expect(page.getByRole('button', { name: 'Run now' })).toBeDisabled();

    await page.getByRole('button', { name: 'Test' }).click();
    const dialog = page.getByRole('dialog', { name: 'Test run' });
    await dialog.locator('textarea').fill(
      JSON.stringify({ name: 'Test User', email: `test-${Date.now().toString(36)}@example.com` }),
    );
    await dialog.getByRole('button', { name: 'Start the test run' }).click();

    await expect(page).toHaveURL(/\/executions\/[0-9a-f-]{36}$/);
    await waitForExecutionStatus(page, 'succeeded');

    // The execution is marked as a test run.
    await expect(page.locator('h1')).toContainText('test run');

    // Test runs are part of the history too, even though they pin a draft and
    // therefore have no published version.
    await page.goto('/executions');
    await expect(page.getByRole('link', { name })).toBeVisible();
  });
});
