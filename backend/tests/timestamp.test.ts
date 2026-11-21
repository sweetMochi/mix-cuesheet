import { describe, expect, it } from 'vitest';
import { formatTimestamp } from '../src/timestamp.ts';

describe('formatTimestamp', () => {
  it.each([
    [0, '00:00'],
    [5, '00:05'],
    [760, '12:40'],
    [3599, '59:59'],
    [3600, '1:00:00'],
    [3723, '1:02:03'],
    [10800, '3:00:00'],
    [36000, '10:00:00'],
  ])('%d 秒 → %s', (seconds, expected) => {
    expect(formatTimestamp(seconds)).toBe(expected);
  });

  it('不足 1 秒的部分捨去', () => {
    expect(formatTimestamp(59.9)).toBe('00:59');
  });
});
