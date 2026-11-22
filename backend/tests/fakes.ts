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
  isBusy: () => false,
  cancel: () => false,
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
export function fakeAudioSource(
  options: {
    prepareError?: unknown;
    extractError?: unknown;
    /** 在這個步驟一直等到取消信號中止，再像子程序被終止一樣丟出中止錯誤 */
    hangIn?: 'prepare' | 'extract';
  } = {},
): FakeAudioSource {
  const source: FakeAudioSource = {
    workDirs: [],
    extracted: [],
    async prepare(_videoId, workDir, signal) {
      source.workDirs.push(workDir);
      await writeFile(path.join(workDir, 'audio.webm'), '');
      if (options.hangIn === 'prepare') {
        await untilAborted(signal);
      }
      if (options.prepareError !== undefined) {
        throw options.prepareError;
      }
      return {
        async extractSegment(segment, segmentSignal) {
          if (options.hangIn === 'extract') {
            await untilAborted(segmentSignal);
          }
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

/** 等到 `signal` 中止後丟出中止錯誤；沒有 `signal` 時永遠不會結束 */
export function untilAborted(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () => reject(new DOMException('aborted', 'AbortError'));
    if (signal?.aborted) {
      abort();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export interface FakeRecognizer extends Recognizer {
  /** 依送出順序記錄每次請求的片段起始秒數，重試也會記錄 */
  calls: number[];
  /** 同時進行中的請求數的最大值 */
  maxInFlight: number;
}

/**
 * 假的辨識器：依片段的起始秒數回傳結果，函式丟出的錯誤會原樣丟出
 *
 * 函式可以回傳 Promise，用來模擬請求需要的時間
 */
export function fakeRecognizer(
  resultAt: (startSeconds: number) => RecognizedTrack | null | Promise<RecognizedTrack | null>,
): FakeRecognizer {
  let inFlight = 0;
  const recognizer: FakeRecognizer = {
    calls: [],
    maxInFlight: 0,
    async recognize(segmentFile) {
      const match = /segment-(\d+(?:\.\d+)?)\.wav$/.exec(segmentFile);
      if (match === null) {
        throw new Error(`無法從檔名取得起始秒數：${segmentFile}`);
      }
      const startSeconds = Number(match[1]);
      recognizer.calls.push(startSeconds);
      inFlight += 1;
      recognizer.maxInFlight = Math.max(recognizer.maxInFlight, inFlight);
      try {
        return await resultAt(startSeconds);
      } finally {
        inFlight -= 1;
      }
    },
  };
  return recognizer;
}

/** 依序回傳結果的函式：第 n 次呼叫取第 n 個，用完後一直取最後一個；值是錯誤時丟出 */
export function sequence(...outcomes: Array<RecognizedTrack | null | Error>) {
  let calls = 0;
  return () => {
    const outcome = outcomes[Math.min(calls++, outcomes.length - 1)]!;
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome;
  };
}

/** 立即返回的等待，記錄每次要求等待的毫秒數 */
export function instantSleep() {
  const delays: number[] = [];
  const sleep = async (ms: number) => {
    delays.push(ms);
  };
  return { sleep, delays };
}

/** 手動放行的等待：每次呼叫都要由測試呼叫 `release()` 才會結束 */
export function manualSleep() {
  const delays: number[] = [];
  const pending: Array<() => void> = [];
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      delays.push(ms);
      pending.push(resolve);
    });
  return {
    sleep,
    delays,
    /** 放行目前所有等待中的呼叫 */
    release: () => pending.splice(0).forEach((resolve) => resolve()),
  };
}
