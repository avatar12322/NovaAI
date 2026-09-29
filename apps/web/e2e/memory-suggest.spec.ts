import { expect, test } from '@playwright/test';
import { loginAs, newConversation } from './helpers';

/**
 * Zgoda wprost w czacie: propozycja asystenta (np. „Zapamiętać: …?”) pod jego wiadomością, z przyciskami
 * Zatwierdź / Odrzuć. E2E działa w trybie demo (bez modelu), więc propozycję i zgodę podstawia test; sam zapis
 * po zgodzie sprawdza test API (model-chat.test.ts).
 */
test('propozycja zapamiętania: zatwierdzenie w czacie wysyła zgodę z wersją akcji', async ({
  page,
}) => {
  await loginAs(page, 'Alfa (test)');
  await newConversation(page, 'private');
  await page.getByLabel('Wiadomość').fill('Nie jem glutenu, pamiętaj przy przepisach');
  await page.getByRole('button', { name: 'Wyślij' }).click();
  await expect(page.locator('.msg-assistant').last()).toContainText('tryb demo', {
    timeout: 15_000,
  });

  let taskId = '';
  await page.route(/\/api\/conversations\/[^/]+\/messages(\?|$)/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const body = (await res.json()) as {
      items: Array<{ role: string; meta: Record<string, unknown> }>;
    };
    const reply = body.items.findLast((m) => m.role === 'assistant')!;
    taskId = String(reply.meta.taskId);
    reply.meta.proposedTools = [{ tool: 'memory.suggest', approval: true }];
    await route.fulfill({ response: res, json: body });
  });
  const hash = 'a'.repeat(64);
  let decided: { actionHash?: string } | null = null;
  await page.route(/\/api\/approvals\?status=pending/, (route) =>
    route.fulfill({
      json: {
        nextCursor: null,
        items: decided
          ? []
          : [
              {
                id: '00000000-0000-4000-8000-000000000001',
                taskId,
                stepId: '00000000-0000-4000-8000-000000000002',
                taskTitle: 'Rozmowa',
                tool: 'memory.suggest',
                capability: 'memory.create',
                action: {},
                actionHash: hash,
                summary: 'Zapamiętać: „Nie je glutenu”?',
                target: 'pamięć prywatna',
                scope: 'profile',
                diff: null,
                status: 'pending',
                expiresAt: new Date(Date.now() + 3600_000).toISOString(),
                resolvedAt: null,
                executedAt: null,
                createdAt: new Date().toISOString(),
              },
            ],
      },
    }),
  );
  await page.route(/\/api\/approvals\/[^/]+\/approve$/, async (route) => {
    decided = route.request().postDataJSON() as { actionHash?: string };
    await route.fulfill({ json: {} });
  });

  await page.reload();
  const card = page.getByRole('group', { name: 'Zgoda: Zapamiętać: „Nie je glutenu”?' });
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card).toContainText('pamięć prywatna');
  await card.getByRole('button', { name: 'Zatwierdź' }).click();
  await expect(card).toHaveCount(0);
  expect(decided).toEqual({ actionHash: hash });
});
