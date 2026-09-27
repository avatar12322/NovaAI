import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { plainText, renderMarkdown } from './markdown';

const html = (text: string) =>
  renderToStaticMarkup(createElement(Fragment, null, renderMarkdown(text)));

describe('Markdown w odpowiedziach asystenta', () => {
  it('pogrubienie, kursywa, kod; bez gwiazdek w wyniku', () => {
    expect(html('Najbliższe zajęcia: **piątek, 2 października** o *10:00*, sala `F 1`.')).toBe(
      'Najbliższe zajęcia: <strong>piątek, 2 października</strong> o <em>10:00</em>, sala <code>F 1</code>.',
    );
  });

  it('listy, listy numerowane, nagłówki, cytat i linia pozioma', () => {
    expect(html('## Plan\n- **10:00** — Bazy\n* Sieci\n1. Pierwsze\n> uwaga\n---')).toBe(
      '<strong>Plan</strong>\n• <strong>10:00</strong> — Bazy\n• Sieci\n1. Pierwsze\n<em>uwaga</em>\n',
    );
  });

  it('niedomknięte ** podczas odsłaniania formatuje resztę zamiast pokazywać gwiazdki', () => {
    expect(html('Masz **piąt')).toBe('Masz <strong>piąt</strong>');
  });

  it('bez fałszywej kursywy: snake_case, mnożenie, pojedyncza gwiazdka', () => {
    expect(html('plik moj_plik_v2.txt, wynik 2*3*4 i gwiazdka * sama')).toBe(
      'plik moj_plik_v2.txt, wynik 2*3*4 i gwiazdka * sama',
    );
  });

  it('linki tylko http(s); HTML z treści jest tekstem', () => {
    expect(html('[Plan](https://example.pl/plan) i [zły](javascript:alert)')).toBe(
      '<a href="https://example.pl/plan" target="_blank" rel="noopener noreferrer">Plan</a> i zły',
    );
    expect(html('<img src=x onerror=alert(1)> **b**')).toBe(
      '&lt;img src=x onerror=alert(1)&gt; <strong>b</strong>',
    );
  });

  it('tekst dla czytnika ekranu bez znaczników', () => {
    expect(plainText('## Plan\n- **10:00** `F 1` [Plan](https://x.pl)')).toBe(
      'Plan\n• 10:00 F 1 Plan',
    );
  });
});
