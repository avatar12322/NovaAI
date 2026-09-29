import { describe, expect, it } from 'vitest';
import { deviceLabel } from './push';

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
