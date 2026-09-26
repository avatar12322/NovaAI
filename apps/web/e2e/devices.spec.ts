import { expect, test } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerSimulator } from '../../api/src/devices/simulator';
import { newConversation } from './helpers';

/**
 * Pełna ścieżka urządzenia w UI: kod parowania → symulator Workera (protokół v1) → grant z formularza →
 * polecenie z czatu → wynik w rozmowie → odłączenie. Symulator zastępuje Windows Workera (ta sama specyfikacja).
 */
test('parowanie urządzenia, grant katalogu i lista plików z czatu', async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), 'nova-e2e-'));
  const root = join(dir, 'projekt');
  await mkdir(root);
  const marker = `plik-${test.info().project.name}.txt`;
  await writeFile(join(root, marker), 'treść');

  await page.goto('/');
  await page.getByRole('button', { name: /Alfa \(test\)/ }).click();
  await page.goto('/#/settings');
  await page.getByRole('button', { name: 'Sparuj urządzenie' }).click();
  const code = (await page.locator('.pairing-code').textContent())!.trim();
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const sim = new WorkerSimulator(
    'http://127.0.0.1:4100',
    { roots: [root], capabilities: ['device.files.read'] },
    join(dir, 'state'),
  );
  await sim.pair(code, `Laptop e2e ${test.info().project.name}`);
  await sim.connect();
  try {
    await page.reload();
    const device = page
      .locator('.device')
      .filter({ hasText: `Laptop e2e ${test.info().project.name}` });
    await expect(device.getByText('online')).toBeVisible();
    await device.getByLabel('Katalog na urządzeniu').fill(root);
    await device.getByRole('button', { name: 'Udostępnij' }).click();
    await expect(device.locator('.grants')).toContainText(root);
    if (test.info().project.name === 'desktop' && process.env.E2E_SCREENSHOTS) {
      await page.screenshot({
        path: join(import.meta.dirname, '../../../docs/screens/desktop-09-devices.png'),
      });
    }

    await newConversation(page);
    await page.getByLabel('Wiadomość').fill(`pliki: ${root}`);
    await page.getByLabel('Wiadomość').press('Enter');
    await expect(page.locator('.msg').filter({ hasText: marker })).toBeVisible({ timeout: 15_000 });

    await page.goto('/#/settings');
    page.once('dialog', (d) => void d.accept());
    await device.getByRole('button', { name: 'Odłącz' }).click();
    await expect(device.getByText('odłączone')).toBeVisible();
  } finally {
    sim.close();
  }
});
