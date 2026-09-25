import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { launchApp } from './helpers';

/** The menu bar glance, which is a window like any other. */
test('tray glance', async () => {
  test.setTimeout(120_000);
  const { app } = await launchApp({ source: 'live', env: { CCV_SOURCE: 'live' } });
  await new Promise((r) => setTimeout(r, 8_000));

  const tray = app.windows().find((w) => w.url().includes('#tray'));
  expect(tray, 'no tray popover window').toBeTruthy();
  await tray!.screenshot({ path: resolve(__dirname, '../../artifacts/shots/tray.png') });
  await app.close();
});
