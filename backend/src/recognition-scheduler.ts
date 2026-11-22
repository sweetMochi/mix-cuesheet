/**
 * 辨識排程：以有上限的並行度送出辨識請求，遇到限流時以共用冷卻加指數退避重試
 *
 * Shazam 的限流以 IP 計算，一個請求被限流時，其他同時進行的請求多半也會被限流，
 * 所以冷卻是所有請求共用的：任一片段被限流時，所有請求都先暫停，等冷卻結束再送出
 */

import { setTimeout as delay } from 'node:timers/promises';
import { RateLimitedError, type RecognizedTrack, type Recognizer } from './recognizer.ts';

export interface RecognitionOptions {
  /** 同時送出的辨識請求數 */
  concurrency: number;
  /** 單一片段遇到限流時最多重試幾次 */
  retryAttempts: number;
  /** 片段第一次重試前的冷卻時間（毫秒），之後每重試一次加倍 */
  backoffBaseMs: number;
  /** 單次冷卻時間的上限（毫秒） */
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
 * 辨識所有片段，依完成的先後產出結果；完成順序不一定和輸入順序相同
 *
 * 每個片段一定會產出一個結果：辨識失敗不會中斷其他片段，失敗原因附在結果中，由呼叫端決定如何記錄。
 * `signal` 中止時不再送出新的請求，並丟出中止的原因
 */
export async function* recognizeSegments(
  input: RecognizeSegmentsInput,
): AsyncGenerator<RecognizedSegment, void, undefined> {
  const { files, recognizer, options, sleep, signal } = input;
  if (!(options.concurrency >= 1)) {
    throw new RangeError('同時請求數必須至少為 1');
  }
  signal?.throwIfAborted();

  const cooldown = new Cooldown(sleep, signal);
  const finished: RecognizedSegment[] = [];
  // 在 worker 的回呼中設定，以 `as` 避免 TypeScript 把它收窄成永遠是空值
  let failure = null as { error: unknown } | null;
  let wake: (() => void) | null = null;
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < files.length && signal?.aborted !== true) {
      const index = nextIndex++;
      const outcome = await recognizeWithRetry(recognizer, files[index]!, cooldown, options, signal);
      finished.push({ index, ...outcome });
      wake?.();
    }
  };
  for (let i = 0; i < Math.min(options.concurrency, files.length); i++) {
    worker().catch((error: unknown) => {
      failure ??= { error };
      wake?.();
    });
  }

  // 中止時不等進行中的請求結束，直接喚醒並丟出
  const onAbort = () => wake?.();
  signal?.addEventListener('abort', onAbort);
  try {
    for (let yielded = 0; yielded < files.length; ) {
      signal?.throwIfAborted();
      if (failure !== null) {
        throw failure.error;
      }
      const result = finished.shift();
      if (result === undefined) {
        await new Promise<void>((resolve) => (wake = resolve));
        wake = null;
        continue;
      }
      yielded += 1;
      yield result;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * 辨識一個片段；被限流時等共用冷卻結束後重試，重試用完或遇到其他錯誤時視為無結果並附上原因
 *
 * `signal` 中止時丟出中止的原因，不視為無結果
 */
async function recognizeWithRetry(
  recognizer: Recognizer,
  file: string,
  cooldown: Cooldown,
  options: RecognitionOptions,
  signal?: AbortSignal,
): Promise<Omit<RecognizedSegment, 'index'>> {
  let requests = 0;
  for (let retries = 0; ; retries++) {
    await cooldown.wait();
    signal?.throwIfAborted();
    try {
      requests += 1;
      const track = await recognizer.recognize(file, signal);
      return { track, failureReason: null, requests, rateLimited: retries };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof RateLimitedError && retries < options.retryAttempts) {
        cooldown.extend(backoffMs(retries, options));
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

/** 第 `retries` 次重試（從 0 起算）前的冷卻時間 */
function backoffMs(retries: number, options: RecognitionOptions): number {
  return Math.min(options.backoffBaseMs * 2 ** retries, options.backoffMaxMs);
}

/** 所有辨識請求共用的冷卻；冷卻期間不送出新的請求 */
class Cooldown {
  private readonly sleep: Sleep;
  private readonly signal: AbortSignal | undefined;
  private gate: Promise<void> | null = null;

  constructor(sleep: Sleep, signal?: AbortSignal) {
    this.sleep = sleep;
    this.signal = signal;
  }

  /** 讓冷卻從現在起至少再持續 `ms` 毫秒；和進行中的冷卻重疊時，以較晚結束的為準 */
  extend(ms: number): void {
    const gate: Promise<void> = Promise.all([this.gate, this.sleep(ms, this.signal)])
      .then(
        () => undefined,
        // 任務中止時冷卻提早結束，交給辨識器處理中止
        () => undefined,
      )
      .finally(() => {
        if (this.gate === gate) {
          this.gate = null;
        }
      });
    this.gate = gate;
  }

  /** 等到沒有冷卻為止；等待期間冷卻被延長時繼續等 */
  async wait(): Promise<void> {
    while (this.gate !== null) {
      await this.gate;
    }
  }
}
