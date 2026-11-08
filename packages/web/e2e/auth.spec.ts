import { expect, test } from '@playwright/test';
import { SEEDED_EMAIL, SEEDED_PASSWORD, signIn } from './utils';

/**
 * Authentication.
 *
 * These tests deliberately start without the stored session: they cover the
 * signed-out paths that the other suites skip.
 */

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('authentication', () => {
  test('redirects an anonymous visitor to the sign-in page', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('button', { name: 'Sign in' }).first()).toBeVisible();
  });

  test('rejects invalid credentials without creating a session', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(SEEDED_EMAIL);
    await page.getByLabel('Password').fill('definitely-not-the-password');
    await page.locator('form button[type="submit"]').click();

    await expect(page.getByText(/invalid email or password/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);

    // Still signed out: a protected page redirects again.
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('signs in with the seeded operator and signs out again', async ({ page }) => {
    await signIn(page);

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    // The dashboard is populated from the seeded demo workspace.
    await expect(page.getByText('Successful runs')).toBeVisible();
    await expect(page.getByText(SEEDED_EMAIL)).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);

    // The session is invalidated: a protected page redirects to the form.
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('creates an account and lands on a provisioned dashboard', async ({ page }) => {
    const email = `e2e-signup-${Date.now()}@example.com`;

    await page.goto('/login');
    await page.getByRole('button', { name: 'Create account' }).first().click();
    await page.getByLabel('Name').fill('New Operator');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('e2e-signup-password');
    await page.locator('form button[type="submit"]').click();

    // Sign-up creates the account only: the first authorized request must
    // provision a workspace, so the dashboard loads instead of bouncing back
    // to the sign-in form.
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();
  });

  test('validates the form before submitting', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill('not-an-email');
    await page.getByLabel('Password').fill(SEEDED_PASSWORD);
    await page.locator('form button[type="submit"]').click();

    // The browser blocks the submit and keeps the user on the form.
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByLabel('Email')).toHaveJSProperty('validity.valid', false);
  });
});
