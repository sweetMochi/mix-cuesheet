/** 切段規劃：決定要從混音影片切出哪些片段 */

export interface SegmentSpec {
  /** 片段在混音影片中的起始秒數 */
  startSeconds: number;
  /** 片段長度（秒）；最後一段可能比設定的片段長度短 */
  durationSeconds: number;
}

export interface SegmentPlanOptions {
  /** 每個片段的長度（秒） */
  segmentSeconds: number;
  /** 相鄰片段起始時間的間隔（秒） */
  stepSeconds: number;
  /** 最後一段剩下的長度少於這個值時略過（秒） */
  minSegmentSeconds: number;
}

/**
 * 依影片長度算出所有片段：從 0 秒開始，每隔一個步距切一段
 *
 * 每段的長度取片段長度和剩餘長度的較小值，剩餘長度太短的最後一段直接略過。
 * 確認畫面的預估片段數和實際切段都必須使用這個函式，兩邊的數字才會一致
 */
export function planSegments(durationSeconds: number, options: SegmentPlanOptions): SegmentSpec[] {
  const { segmentSeconds, stepSeconds, minSegmentSeconds } = options;
  if (stepSeconds <= 0 || segmentSeconds <= 0) {
    throw new RangeError('片段長度與步距必須大於 0');
  }

  const segments: SegmentSpec[] = [];
  for (let start = 0; start < durationSeconds; start += stepSeconds) {
    const length = Math.min(segmentSeconds, durationSeconds - start);
    if (length < minSegmentSeconds) {
      break;
    }
    segments.push({ startSeconds: start, durationSeconds: length });
  }
  return segments;
}
