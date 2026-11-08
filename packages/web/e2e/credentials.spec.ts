import { expect, test } from '@playwright/test';
import { uniqueName } from './utils';

/**
 * Credentials.
 *
 * The API never returns a secret, so the UI can only prove that a secret
 * exists. This test covers the whole lifecycle: create, rotate, delete.
 */

test.describe('credentials', () => {
  test('creates, rotates and deletes a credential', async ({ page }) => {
    const name = uniqueName('E2E Credential');

    await page.goto('/credentials');
    await expect(page.getByRole('heading', { name: 'Credentials', level: 1 })).toBeVisible();

    // ------------------------------------------------------------- create
    await page.getByRole('button', { name: 'Add credential' }).click();
    const createDialog = page.getByRole('dialog', { name: 'Add a credential' });
    await createDialog.getByLabel('Name').fill(name);
    await createDialog.getByLabel('Provider').selectOption('http_header');
    await createDialog.getByLabel('Secret').fill('first-e2e-secret');
    await createDialog.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByText('The credential was saved')).toBeVisible();

    const row = page.getByRole('row', { name: new RegExp(name) });
    await expect(row).toBeVisible();
    await expect(row.getByText('stored (hidden)')).toBeVisible();
    await expect(row.getByText('http_header')).toBeVisible();

    // ------------------------------------------------------------- rotate
    await row.getByTitle('Rotate the secret').click();
    const rotateDialog = page.getByRole('dialog', { name: 'Rotate the secret' });
    await rotateDialog.getByLabel('New secret').fill('second-e2e-secret');
    await rotateDialog.getByRole('button', { name: 'Rotate' }).click();

    await expect(page.getByText('The secret was rotated')).toBeVisible();
    await expect(row).toBeVisible();

    // ------------------------------------------------------------- delete
    await row.getByTitle('Delete the credential').click();
    const deleteDialog = page.getByRole('dialog', { name: 'Delete this credential?' });
    await deleteDialog.getByRole('button', { name: 'Delete' }).click();

    await expect(page.getByText('The credential was deleted')).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(name) })).toHaveCount(0);
  });
});
