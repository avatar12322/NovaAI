import { expect, test } from '@playwright/test';
import { loginAs, shot } from './helpers';

/** Przegląd dnia na stronie „Dom”: powitanie, kafelki dnia i odczyt na głos (atrapa syntezy mowy). */
test('przegląd dnia: powitanie, kafelki i odczyt na głos', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __spoken: string[] };
    w.__spoken = [];
    window.speechSynthesis.speak = (u: SpeechSynthesisUtterance) => {
      w.__spoken.push(u.text);
    };
    window.speechSynthesis.cancel = () => undefined;
  });
  await loginAs(page, 'Alfa (test)');
  await page.goto('/#/home');
  const panel = page.getByRole('region', { name: 'Przegląd dnia' });
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(
    /^(Dzień dobry|Dobry wieczór), Alfa$/,
  );
  for (const title of ['Dziś w kalendarzu', 'Przypomnienia', 'Czeka na zgodę', 'Koszt modeli'])
    await expect(panel.getByText(title)).toBeVisible();
  // Kafelki wchodzą po kolei — zrzut po zakończeniu animacji.
  await expect(panel.locator('.briefing-item').last()).toHaveCSS('opacity', '1');
  await shot(page, '21-briefing');

  await panel.getByRole('button', { name: 'Przeczytaj przegląd' }).click();
  const spoken = await page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken);
  expect(spoken).toHaveLength(1);
  expect(spoken[0]).toMatch(/^(Dzień dobry|Dobry wieczór), Alfa\. Dziś /);
  await expect(panel.locator('.orb')).toHaveClass(/orb-speaking/);
});
