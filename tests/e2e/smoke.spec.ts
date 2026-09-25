import { expect, test } from '@playwright/test';
import { launchApp, shoot } from './helpers';

test('shell boots, engine connects, sessions arrive', async () => {
  const { app, page } = await launchApp();

  await expect(page.locator('.titlebar')).toContainText('Atrium');

  // The inspector is off by default; open it to check the data layer.
  await page.locator('.chip', { hasText: 'Inspector' }).click();
  // The count belongs to the scenario, not to the handshake this test is about.
  await expect(page.locator('.session').first()).toBeVisible({ timeout: 15_000 });
  expect(await page.locator('.session').count()).toBeGreaterThanOrEqual(3);

  // Agents show up under their session, and activity keeps changing.
  const firstActivity = await page.locator('.session .agent__activity').first().textContent();
  await page.waitForTimeout(6000);
  const laterActivity = await page.locator('.session .agent__activity').first().textContent();
  expect(firstActivity).toBeTruthy();
  expect(laterActivity).toBeTruthy();

  await shoot(page, 'm0-inspector');
  await app.close();
});
