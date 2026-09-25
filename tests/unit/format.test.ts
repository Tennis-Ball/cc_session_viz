import { describe, expect, it } from 'vitest';
import { fmtDuration, fmtTokens, hash32, modelInfo, repoName, turnVerb } from '@shared/format';

describe('modelInfo', () => {
  it('labels the model families the way Claude Code does', () => {
    expect(modelInfo('claude-opus-5').label).toBe('Opus 5');
    expect(modelInfo('claude-fable-5-1').label).toBe('Fable 5.1');
    expect(modelInfo('claude-haiku-4-5-20251001').label).toBe('Haiku 4.5');
    expect(modelInfo('claude-sonnet-5').label).toBe('Sonnet 5');
  });

  it('reads the 1M context marker, which only appears on the model attachment', () => {
    expect(modelInfo('claude-opus-5[1m]').window).toBe(1_000_000);
    expect(modelInfo('claude-haiku-4-5-20251001').window).toBe(200_000);
  });

  it('orders tiers by model size, which drives figure scale', () => {
    expect(modelInfo('claude-haiku-4-5').tier).toBeLessThan(modelInfo('claude-sonnet-5').tier);
    expect(modelInfo('claude-sonnet-5').tier).toBeLessThan(modelInfo('claude-opus-5').tier);
    expect(modelInfo('claude-opus-5').tier).toBeLessThan(modelInfo('claude-fable-5-1').tier);
  });

  it('degrades gracefully on unknown ids', () => {
    const info = modelInfo(undefined);
    expect(info.family).toBe('unknown');
    expect(info.window).toBe(200_000);
  });
});

describe('formatting', () => {
  it('formats tokens like the status line', () => {
    expect(fmtTokens(940)).toBe('940');
    expect(fmtTokens(15_100)).toBe('15.1k');
    expect(fmtTokens(565_000)).toBe('565k');
    expect(fmtTokens(1_240_000)).toBe('1.2M');
  });

  it('formats durations like the turn-end line', () => {
    expect(fmtDuration(23_000)).toBe('23s');
    expect(fmtDuration(2_347_000)).toBe('39m 7s');
    expect(fmtDuration(3_600_000)).toBe('1h');
  });

  it('derives a repo name from a cwd', () => {
    expect(repoName('/Users/x/code/atrium')).toBe('atrium');
  });
});

describe('turn verbs', () => {
  it('is stable for a given seed', () => {
    expect(turnVerb(hash32('slot-a'))).toBe(turnVerb(hash32('slot-a')));
  });
});
