import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CAPS, capsFromSettings, localDayStart, raisedStop, settingsWithCaps, spendLevel, usd, validateCaps,
} from './spend';

describe('spendLevel', () => {
  const caps = { warnUsd: 5, stopUsd: 20 };
  it('is ok below the warning, warn from the warning, stop from the stop', () => {
    expect(spendLevel(0, caps)).toBe('ok');
    expect(spendLevel(4.99, caps)).toBe('ok');
    expect(spendLevel(5, caps)).toBe('warn');
    expect(spendLevel(19.99, caps)).toBe('warn');
    expect(spendLevel(20, caps)).toBe('stop');
    expect(spendLevel(1000, caps)).toBe('stop');
  });
  it('a stop of zero stops everything, which is what zero says', () => {
    expect(spendLevel(0, { warnUsd: 0, stopUsd: 0 })).toBe('stop');
  });
});

describe('localDayStart', () => {
  it('is midnight local time on the same day, and idempotent', () => {
    const now = new Date(2026, 8, 15, 13, 47, 12, 345).getTime();
    const start = localDayStart(now);
    const d = new Date(start);
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 8, 15]);
    expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([0, 0, 0, 0]);
    expect(localDayStart(start)).toBe(start);
    expect(start).toBeLessThanOrEqual(now);
    expect(now - start).toBeLessThan(24 * 3600 * 1000);
  });
});

describe('validateCaps', () => {
  it('accepts sane numbers and rounds them to cents', () => {
    expect(validateCaps({ warnUsd: 2.005, stopUsd: 10.333 })).toEqual({ warnUsd: 2.01, stopUsd: 10.33 });
    expect(validateCaps({ warnUsd: 0, stopUsd: 0 })).toEqual({ warnUsd: 0, stopUsd: 0 });
  });
  it('refuses negatives, non-numbers, and a warning above the stop', () => {
    expect(() => validateCaps({ warnUsd: -1, stopUsd: 5 })).toThrow(/warning/);
    expect(() => validateCaps({ warnUsd: Number.NaN, stopUsd: 5 })).toThrow(/warning/);
    expect(() => validateCaps({ warnUsd: 1, stopUsd: Number.POSITIVE_INFINITY })).toThrow(/stop/);
    expect(() => validateCaps({ warnUsd: 6, stopUsd: 5 })).toThrow(/cannot be higher/);
  });
});

describe('raisedStop', () => {
  it('doubles, and never moves by less than five dollars', () => {
    expect(raisedStop(20)).toBe(40);
    expect(raisedStop(0)).toBe(5);
    expect(raisedStop(2)).toBe(7);
    expect(raisedStop(5)).toBe(10);
  });
});

describe('settings round trip', () => {
  it('defaults when there is nothing, or nothing readable', () => {
    expect(capsFromSettings(null)).toEqual(DEFAULT_CAPS);
    expect(capsFromSettings('not json')).toEqual(DEFAULT_CAPS);
    expect(capsFromSettings('{"ui":{}}')).toEqual(DEFAULT_CAPS);
    expect(capsFromSettings('{"spend":{"warnUsd":"5","stopUsd":-3}}')).toEqual(DEFAULT_CAPS);
  });
  it('fills a missing half from the defaults, and refuses an inverted pair', () => {
    expect(capsFromSettings('{"spend":{"stopUsd":50}}')).toEqual({ warnUsd: 5, stopUsd: 50 });
    expect(capsFromSettings('{"spend":{"warnUsd":30}}')).toEqual(DEFAULT_CAPS);
  });
  it('writes the caps without disturbing other settings', () => {
    const written = settingsWithCaps('{"ui":{"theme":"dark"},"spend":{"warnUsd":1,"stopUsd":2}}', { warnUsd: 5, stopUsd: 40 });
    expect(JSON.parse(written)).toEqual({ ui: { theme: 'dark' }, spend: { warnUsd: 5, stopUsd: 40 } });
    expect(capsFromSettings(written)).toEqual({ warnUsd: 5, stopUsd: 40 });
    expect(JSON.parse(settingsWithCaps(null, DEFAULT_CAPS))).toEqual({ spend: DEFAULT_CAPS });
    expect(JSON.parse(settingsWithCaps('[1,2]', DEFAULT_CAPS))).toEqual({ spend: DEFAULT_CAPS });
  });
});

describe('usd', () => {
  it('shows cents, and four places only when a cent would hide the number', () => {
    expect(usd(0)).toBe('$0.00');
    expect(usd(0.0042)).toBe('$0.0042');
    expect(usd(0.01)).toBe('$0.01');
    expect(usd(25)).toBe('$25.00');
  });
});
