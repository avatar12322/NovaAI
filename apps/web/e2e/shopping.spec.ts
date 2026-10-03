import { expect, test } from '@playwright/test';
import { loginAs, logout, shot } from './helpers';

/** Ekran „Zakupy” (wspólna lista domu): Alfa dodaje, Beta odhacza i usuwa kupione. */
test('lista zakupów: dodawanie po przecinku, odhaczanie przez domownika, usuwanie kupionych', async ({
  page,
}) => {
  const tag = `${test.info().project.name}-${Date.now()}`;
  const milk = `mleko ${tag}`;
  const eggs = `jajka ${tag}`;
  await loginAs(page, 'Alfa (test)');
  await page.goto('/#/shopping');
  const panel = page.getByRole('region', { name: 'Lista zakupów' });
  await panel.getByLabel('Co dodać do listy zakupów').fill(`${milk}, ${eggs}`);
  await panel.getByRole('button', { name: 'Dodaj', exact: true }).click();
  const todo = panel.getByRole('list', { name: 'Do kupienia' });
  await expect(todo).toContainText(milk);
  await expect(todo).toContainText(eggs);
  await panel.getByRole('checkbox', { name: milk }).scrollIntoViewIfNeeded();
  await shot(page, '42-shopping');
  await logout(page);

  await loginAs(page, 'Beta (test)');
  await page.goto('/#/shopping');
  const betaPanel = page.getByRole('region', { name: 'Lista zakupów' });
  await expect(betaPanel.getByRole('list', { name: 'Do kupienia' })).toContainText('Alfa (test)');
  await betaPanel.getByRole('checkbox', { name: milk }).check();
  await expect(betaPanel.getByRole('list', { name: 'Kupione' })).toContainText(milk);
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Lista zakupów' }).getByRole('checkbox', { name: milk }),
  ).toBeChecked();
  await betaPanel.getByRole('button', { name: `Usuń: ${eggs}` }).click();
  await expect(betaPanel.getByRole('checkbox', { name: eggs })).toHaveCount(0);
  await betaPanel.getByRole('button', { name: /Usuń kupione/ }).click();
  await expect(betaPanel.getByRole('checkbox', { name: milk })).toHaveCount(0);
});

test('lista zakupów na żywo: odhaczenie u domownika widać od razu, bez odświeżania', async ({
  browser,
}) => {
  const tag = `${test.info().project.name}-${Date.now()}`;
  const bread = `chleb ${tag}`;
  const use = test.info().project.use;
  const open = async (who: 'Alfa (test)' | 'Beta (test)') => {
    const ctx = await browser.newContext({ ...use, baseURL: use.baseURL });
    const page = await ctx.newPage();
    await loginAs(page, who);
    await page.goto('/#/shopping');
    return { ctx, panel: page.getByRole('region', { name: 'Lista zakupów' }) };
  };
  const alfa = await open('Alfa (test)');
  const beta = await open('Beta (test)');
  try {
    await alfa.panel.getByLabel('Co dodać do listy zakupów').fill(bread);
    await alfa.panel.getByRole('button', { name: 'Dodaj', exact: true }).click();
    // Nowa pozycja pojawia się u Bety bez odświeżania…
    await expect(beta.panel.getByRole('checkbox', { name: bread })).not.toBeChecked();
    // …a jej odhaczenie od razu u Alfy.
    await beta.panel.getByRole('checkbox', { name: bread }).check();
    await expect(alfa.panel.getByRole('checkbox', { name: bread })).toBeChecked();
    await expect(alfa.panel.getByRole('list', { name: 'Kupione' })).toContainText(bread);
    await alfa.panel.getByRole('checkbox', { name: bread }).uncheck();
    await expect(beta.panel.getByRole('checkbox', { name: bread })).not.toBeChecked();
    await beta.panel.getByRole('button', { name: `Usuń: ${bread}` }).click();
    await expect(alfa.panel.getByRole('checkbox', { name: bread })).toHaveCount(0);
  } finally {
    await alfa.ctx.close();
    await beta.ctx.close();
  }
});
