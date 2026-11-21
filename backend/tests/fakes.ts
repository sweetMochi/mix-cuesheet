/** 測試用的假相依 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AnalysisJobs } from '../src/analysis-jobs.ts';
import type { AudioSource } from '../src/audio-source.ts';
import type { RecognizedTrack, Recognizer } from '../src/recognizer.ts';
import type { SegmentSpec } from '../src/segment-plan.ts';

/** 不應該被用到的任務管理；用在只測其他端點的測試 */
export const unusedJobs: AnalysisJobs = {
  start: () => {
    throw new Error('不應該建立分析任務');
  },
  events: () => null,
};

export function track(id: string): RecognizedTrack {
  return {
    trackId: id,
    artist: `Artist ${id}`,
    title: `Title ${id}`,
    shazamUrl: `https://www.shazam.com/track/${id}`,
    coverUrl: null,
  };
}

export interface FakeAudioSource extends AudioSource {
  /** `prepare` 收到的暫存資料夾 */
  workDirs: string[];
  /** 依序被切出的片段 */
  extracted: SegmentSpec[];
}

/**
 * 假的音訊來源：在暫存資料夾寫出空的片段檔，檔名帶著起始秒數，讓假的辨識器依此決定結果
 */
export function fakeAudioSource(options: { prepareError?: unknown; extractError?: unknown } = {}): FakeAudioSource {
  const source: FakeAudioSource = {
    workDirs: [],
    extracted: [],
    async prepare(_videoId, workDir) {
      source.workDirs.push(workDir);
      await writeFile(path.join(workDir, 'audio.webm'), '');
      if (options.prepareError !== undefined) {
        throw options.prepareError;
      }
      return {
        async extractSegment(segment) {
          if (options.extractError !== undefined) {
            throw options.extractError;
          }
          source.extracted.push(segment);
          const file = path.join(workDir, `segment-${segment.startSeconds}.wav`);
          await writeFile(file, '');
          return file;
        },
      };
    },
  };
  return source;
}

/** 假的辨識器：依片段的起始秒數回傳結果，函式丟出的錯誤會原樣丟出 */
export function fakeRecognizer(
  resultAt: (startSeconds: number) => RecognizedTrack | null,
): Recognizer & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    async recognize(segmentFile) {
      const match = /segment-(\d+(?:\.\d+)?)\.wav$/.exec(segmentFile);
      if (match === null) {
        throw new Error(`無法從檔名取得起始秒數：${segmentFile}`);
      }
      const startSeconds = Number(match[1]);
      calls.push(startSeconds);
      return resultAt(startSeconds);
    },
  };
}
