/** 曲目表：把各片段的辨識結果合併成依開始時間排序的曲目列 */

import type { RecognizedTrack } from './recognizer.ts';
import type { SegmentSpec } from './segment-plan.ts';
import { formatTimestamp } from './timestamp.ts';

/** 單一片段已完成的辨識結果 */
export interface SegmentResult {
  startSeconds: number;
  /** 辨識到的曲目；無結果時為空值 */
  track: RecognizedTrack | null;
}

/** 一首曲目；整支影片中命中同一首的片段都併入這一列 */
export interface TrackRow {
  kind: 'track';
  /** 最早一次命中的片段起始秒數 */
  startSeconds: number;
  /** 格式化後的開始時間，例如 `12:40`、`1:02:03` */
  startText: string;
  /** 最早一次命中時的辨識結果 */
  track: RecognizedTrack;
  /** 整支影片中命中這首曲目的片段數 */
  hitCount: number;
  /** 「待確認」標記：整支影片中只有 1 個片段命中這首曲目 */
  singleHit: boolean;
}

/** 連續 2 個以上的無結果片段合併成的「未辨識」區間 */
export interface UnrecognizedRow {
  kind: 'unrecognized';
  /** 第一個無結果片段的起始秒數 */
  startSeconds: number;
  startText: string;
  /** 緊接在最後一個無結果片段之後的片段起始秒數，沒有下一個片段時為影片結尾 */
  endSeconds: number;
  endText: string;
}

export type CuesheetRow = TrackRow | UnrecognizedRow;

export interface Cuesheet {
  rows: CuesheetRow[];
}

export interface CuesheetInput {
  /** 切段規劃的所有片段，依起始時間排序 */
  segments: readonly SegmentSpec[];
  /** 混音影片長度（秒），作為最後一段「未辨識」區間的結尾 */
  durationSeconds: number;
  /** 已完成的辨識結果；沒有出現在這裡的片段視為待處理 */
  results: readonly SegmentResult[];
}

/** 連續幾個無結果片段才合併成一列「未辨識」 */
const MIN_UNRECOGNIZED_SEGMENTS = 2;

/**
 * 依已完成的辨識結果算出曲目表
 *
 * - 以曲目識別碼判斷是否為同一首；每首曲目只出現一次，開始時間取最早一次命中的片段起始時間，
 *   不論中間隔了多少無結果片段或其他曲目
 * - 連續 2 個以上的無結果片段合併成一列「未辨識」，單一個無結果片段忽略
 * - 待處理的片段不算無結果，也會中斷連續無結果片段的計算
 * - 曲目列與「未辨識」列一起依開始時間排序
 */
export function buildCuesheet({ segments, durationSeconds, results }: CuesheetInput): Cuesheet {
  const completed = new Map(results.map((result) => [result.startSeconds, result.track]));
  const tracks = new Map<string, Omit<TrackRow, 'singleHit'>>();
  const unrecognized: UnrecognizedRow[] = [];
  /** 目前這一串連續無結果片段 */
  let noResultRun: { startSeconds: number; count: number } | null = null;

  const closeRun = (endSeconds: number) => {
    if (noResultRun !== null && noResultRun.count >= MIN_UNRECOGNIZED_SEGMENTS) {
      unrecognized.push({
        kind: 'unrecognized',
        startSeconds: noResultRun.startSeconds,
        startText: formatTimestamp(noResultRun.startSeconds),
        endSeconds,
        endText: formatTimestamp(endSeconds),
      });
    }
    noResultRun = null;
  };

  for (const { startSeconds } of segments) {
    if (!completed.has(startSeconds)) {
      // 待處理
      closeRun(startSeconds);
      continue;
    }

    const track = completed.get(startSeconds)!;
    if (track === null) {
      noResultRun ??= { startSeconds, count: 0 };
      noResultRun.count += 1;
      continue;
    }

    closeRun(startSeconds);
    const row = tracks.get(track.trackId);
    if (row === undefined) {
      tracks.set(track.trackId, {
        kind: 'track',
        startSeconds,
        startText: formatTimestamp(startSeconds),
        track,
        hitCount: 1,
      });
    } else {
      row.hitCount += 1;
    }
  }
  closeRun(durationSeconds);

  const trackRows = [...tracks.values()].map((row): TrackRow => ({ ...row, singleHit: row.hitCount === 1 }));
  const rows: CuesheetRow[] = [...trackRows, ...unrecognized].sort((a, b) => a.startSeconds - b.startSeconds);
  return { rows };
}
