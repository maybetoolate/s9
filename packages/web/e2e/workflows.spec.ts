import { expect, test } from '@playwright/test';
import { createManualWorkflow, publishWorkflow, uniqueName } from './utils';

/**
 * Workflows.
 *
 * The seeded demo proves the list and the filters; the wizard tests create
 * their own workflows so a failure cannot be blamed on seed data.
 */

test.describe('workflows', () => {
  test('lists the seeded workflow and filters by name', async ({ page }) => {
    await page.goto('/workflows');

    await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Contact form follow-up' })).toBeVisible();

    await page.getByPlaceholder('Search by name').fill('Contact form follow-up');
    await page.getByRole('button', { name: 'Filter' }).click();

    await expect(page).toHaveURL(/search=Contact\+form\+follow-up/);
    await expect(page.getByRole('link', { name: 'Contact form follow-up' })).toBeVisible();
    await expect(page.getByText('1 workflow in this workspace.')).toBeVisible();

    await page.getByPlaceholder('Search by name').fill('no-such-workflow-anywhere');
    await page.getByRole('button', { name: 'Filter' }).click();

    await expect(page.getByText('No workflows yet')).toBeVisible();
  });

  test('creates a draft through the creation wizard', async ({ page }) => {
    const name = uniqueName('E2E Draft');

    await createManualWorkflow(page, name);

    await expect(page.getByRole('heading', { name })).toBeVisible();
    await expect(page.getByText('draft', { exact: true })).toBeVisible();
    await expect(page.getByText('Save contact')).toBeVisible();
    await expect(page.getByText(/Saved · revision \d+/)).toBeVisible();
  });

  test('validates and publishes a workflow', async ({ page }) => {
    const name = uniqueName('E2E Published');

    await createManualWorkflow(page, name);
    await publishWorkflow(page);

    await expect(page.getByRole('button', { name: 'Run now' })).toBeEnabled();

    // The published version is visible in the Versions tab.
    await page.getByRole('tab', { name: 'Versions' }).click();
    const versions = page.getByRole('tabpanel');
    await expect(versions.getByText('Version 1', { exact: false })).toBeVisible();
    await expect(versions.getByText('current')).toBeVisible();
  });

  test('shows validation results for a valid definition', async ({ page }) => {
    const name = uniqueName('E2E Validate');

    await createManualWorkflow(page, name);

    await page.getByRole('button', { name: 'Validate' }).click();
    await expect(page.getByText('The workflow is valid')).toBeVisible();

    // No error alert is rendered when the definition is valid.
    await expect(page.getByText('Validation issues')).toHaveCount(0);
  });
});
