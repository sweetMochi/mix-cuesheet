/** 曲目表：把各片段的辨識結果合併成依開始時間排序的曲目列 */

import type { RecognizedTrack } from './recognizer.ts';
import { formatTimestamp } from './timestamp.ts';

/** 單一片段已完成的辨識結果 */
export interface SegmentResult {
  startSeconds: number;
  /** 辨識到的曲目；無結果時為空值 */
  track: RecognizedTrack | null;
}

export interface TrackRow {
  kind: 'track';
  /** 第一次命中的片段起始秒數 */
  startSeconds: number;
  /** 格式化後的開始時間，例如 `12:40`、`1:02:03` */
  startText: string;
  track: RecognizedTrack;
  /** 併入這一列的片段數 */
  hitCount: number;
}

export type CuesheetRow = TrackRow;

export interface Cuesheet {
  rows: CuesheetRow[];
}

/**
 * 依已完成的辨識結果算出曲目表
 *
 * 目前只做最簡單的合併：依時間順序，連續命中同一首曲目時合併成一列，開始時間取第一次命中的片段起始時間。
 * 無結果的片段不會打斷連續命中，也不會產生曲目列
 */
export function buildCuesheet(results: readonly SegmentResult[]): Cuesheet {
  const sorted = [...results].sort((a, b) => a.startSeconds - b.startSeconds);
  const rows: TrackRow[] = [];
  for (const { startSeconds, track } of sorted) {
    if (track === null) {
      continue;
    }
    const last = rows.at(-1);
    if (last !== undefined && last.track.trackId === track.trackId) {
      last.hitCount += 1;
    } else {
      rows.push({ kind: 'track', startSeconds, startText: formatTimestamp(startSeconds), track, hitCount: 1 });
    }
  }
  return { rows };
}
