import { expect, test as setup } from '@playwright/test';
import { SEEDED_EMAIL, signIn } from './utils';

/**
 * Signs in once and stores the browser state.
 *
 * The other projects depend on this one, so the main tests start authenticated
 * and only the authentication suite exercises the signed-out paths.
 */

const authFile = 'e2e/.auth/user.json';

setup('sign in as the seeded operator', async ({ page }) => {
  await signIn(page);

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText(SEEDED_EMAIL)).toBeVisible();

  await page.context().storageState({ path: authFile });
});
