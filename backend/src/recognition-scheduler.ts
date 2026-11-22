/**
 * 辨識排程：依片段順序一次送出一個辨識請求，遇到限流時以指數退避重試
 *
 * Shazam 的限流以 IP 計算，實際速度由補名額的速度決定，同時送出多個請求只會互相搶名額，
 * 實測反而更慢、失敗更多（見 config.ts 的註解），所以不並行
 */

import { setTimeout as delay } from 'node:timers/promises';
import { RateLimitedError, type RecognizedTrack, type Recognizer } from './recognizer.ts';

export interface RecognitionOptions {
  /** 單一片段遇到限流時最多重試幾次 */
  retryAttempts: number;
  /** 片段第一次重試前的等待時間（毫秒），之後每重試一次加倍 */
  backoffBaseMs: number;
  /** 單次等待時間的上限（毫秒） */
  backoffMaxMs: number;
}

/** 等待指定的毫秒數；`signal` 中止時提早結束 */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const defaultSleep: Sleep = (ms, signal) => delay(ms, undefined, { signal });

export interface RecognizedSegment {
  /** 片段在輸入清單中的位置 */
  index: number;
  /** 辨識到的曲目；無結果、重試用完或其他辨識錯誤時為空值 */
  track: RecognizedTrack | null;
  /** 重試用完或遇到其他辨識錯誤時的原因；辨識成功或無結果時為空值 */
  failureReason: string | null;
  /** 這個片段呼叫辨識器的次數，包含被限流的請求 */
  requests: number;
  /** 這個片段被限流的次數 */
  rateLimited: number;
}

export interface RecognizeSegmentsInput {
  /** 依起始時間排序的片段檔 */
  files: readonly string[];
  recognizer: Recognizer;
  options: RecognitionOptions;
  sleep: Sleep;
  signal?: AbortSignal;
}

/**
 * 依序辨識所有片段，前一段完成後才送出下一段，結果依輸入順序產出
 *
 * 每個片段一定會產出一個結果：辨識失敗不會中斷其他片段，失敗原因附在結果中，由呼叫端決定如何記錄。
 * `signal` 中止時不再送出新的請求，並丟出中止的原因
 */
export async function* recognizeSegments(
  input: RecognizeSegmentsInput,
): AsyncGenerator<RecognizedSegment, void, undefined> {
  const { files, recognizer, options, sleep, signal } = input;
  for (const [index, file] of files.entries()) {
    signal?.throwIfAborted();
    yield { index, ...(await recognizeWithRetry(recognizer, file, options, sleep, signal)) };
  }
}

/**
 * 辨識一個片段；被限流時等待退避時間後重試，重試用完或遇到其他錯誤時視為無結果並附上原因
 *
 * `signal` 中止時丟出中止的原因，不視為無結果
 */
async function recognizeWithRetry(
  recognizer: Recognizer,
  file: string,
  options: RecognitionOptions,
  sleep: Sleep,
  signal?: AbortSignal,
): Promise<Omit<RecognizedSegment, 'index'>> {
  let requests = 0;
  for (let retries = 0; ; retries++) {
    signal?.throwIfAborted();
    try {
      requests += 1;
      const track = await recognizer.recognize(file, signal);
      return { track, failureReason: null, requests, rateLimited: retries };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof RateLimitedError && retries < options.retryAttempts) {
        // 任務中止時等待會提早結束，交給下一輪開頭丟出中止的原因
        await sleep(backoffMs(retries, options), signal).catch(() => undefined);
        continue;
      }
      const isRateLimited = error instanceof RateLimitedError;
      return {
        track: null,
        failureReason: isRateLimited ? `限流重試 ${retries} 次後仍被限流` : String(error),
        requests,
        rateLimited: isRateLimited ? retries + 1 : retries,
      };
    }
  }
}

/** 第 `retries` 次重試（從 0 起算）前的等待時間 */
function backoffMs(retries: number, options: RecognitionOptions): number {
  return Math.min(options.backoffBaseMs * 2 ** retries, options.backoffMaxMs);
}
