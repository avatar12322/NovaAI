import { describe, expect, it } from 'vitest';
import { deviceLabel, isIos } from './push';

describe('deviceLabel', () => {
  it('nazwa urządzenia i przeglądarki bez szczegółów', () => {
    expect(
      deviceLabel(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('iPhone · Safari');
    expect(
      deviceLabel(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0',
      ),
    ).toBe('Windows · Edge');
    expect(deviceLabel('coś nieznanego')).toBe('urządzenie');
  });
});

describe('isIos', () => {
  it('iPhone oraz iPad przedstawiający się jako Mac (ekran dotykowy)', () => {
    expect(isIos('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5)).toBe(true);
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 5)).toBe(
      true,
    );
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 0)).toBe(
      false,
    );
    expect(isIos('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 0)).toBe(false);
  });
});
