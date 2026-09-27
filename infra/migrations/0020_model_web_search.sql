-- 0020: wyszukiwanie w internecie (narzędzie serwerowe Anthropic) — cena za 1000 wyszukań w walucie cennika modelu.
-- Puste => wyszukiwanie wyłączone dla tego modelu (bez ceny budżet nie mógłby go rozliczyć).
ALTER TABLE household_models
  ADD COLUMN web_search_per_1k numeric CHECK (web_search_per_1k >= 0);
