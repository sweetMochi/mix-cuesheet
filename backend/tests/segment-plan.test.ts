import { describe, expect, it } from 'vitest';
import { planSegments } from '../src/segment-plan.ts';

const options = { segmentSeconds: 12, stepSeconds: 20, minSegmentSeconds: 5 };

const starts = (durationSeconds: number) =>
  planSegments(durationSeconds, options).map((segment) => segment.startSeconds);

describe('planSegments', () => {
  it('從 0 秒開始，每隔一個步距切一段', () => {
    expect(planSegments(60, options)).toEqual([
      { startSeconds: 0, durationSeconds: 12 },
      { startSeconds: 20, durationSeconds: 12 },
      { startSeconds: 40, durationSeconds: 12 },
    ]);
  });

  it('最後一段的長度取片段長度與剩餘長度的較小值', () => {
    expect(planSegments(48, options).at(-1)).toEqual({ startSeconds: 40, durationSeconds: 8 });
  });

  it('最後一段剩下剛好 5 秒時保留', () => {
    expect(starts(45)).toEqual([0, 20, 40]);
  });

  it('最後一段剩下不到 5 秒時略過', () => {
    expect(starts(44)).toEqual([0, 20]);
    expect(starts(40.5)).toEqual([0, 20]);
  });

  it('起始秒數等於影片長度時不切段', () => {
    expect(starts(40)).toEqual([0, 20]);
  });

  it('影片比最短片段還短時沒有片段', () => {
    expect(planSegments(4, options)).toEqual([]);
    expect(planSegments(0, options)).toEqual([]);
  });

  it('影片短於一個片段但至少 5 秒時只切一段', () => {
    expect(planSegments(8, options)).toEqual([{ startSeconds: 0, durationSeconds: 8 }]);
  });

  it('1 小時的混音切成 180 段', () => {
    const segments = planSegments(3600, options);

    expect(segments).toHaveLength(180);
    expect(segments.at(-1)).toEqual({ startSeconds: 3580, durationSeconds: 12 });
  });

  it('片段長度或步距不是正數時丟出錯誤', () => {
    expect(() => planSegments(60, { ...options, stepSeconds: 0 })).toThrow(RangeError);
    expect(() => planSegments(60, { ...options, segmentSeconds: -1 })).toThrow(RangeError);
  });
});
