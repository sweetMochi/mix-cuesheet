/**
 * 辨識器的實際實作：以 `shazamio-core`（WASM 版）產生簽章，再以 `fetch` 送出 Shazam 辨識請求
 *
 * 請求格式參照 Python `shazamio` 0.9.0。Shazam 的 API 是非官方的，改版時要對照 `shazamio` 的更新內容維護
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { recognizeBytes } from 'shazamio-core';
import { RateLimitedError, type RecognizedTrack, type Recognizer } from './recognizer.ts';

export interface ShazamSignature {
  uri: string;
  samplems: number;
}

/** 從片段檔產生簽章；音訊太短而無法產生簽章時回傳空值 */
export type SignFile = (file: string) => Promise<ShazamSignature | null>;

export interface ShazamRecognizerOptions {
  fetch?: typeof fetch;
  sign?: SignFile;
  timeZone?: string;
  /** 單一請求的逾時（毫秒） */
  timeoutMs?: number;
}

const URL_TEMPLATE =
  'https://amp.shazam.com/discovery/v5/en-US/US/iphone/-/tag/{u1}/{u2}' +
  '?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3&sharehub=true&hubv5minorversion=v5.1&hidelb=true&video=v3';

const HEADERS = {
  'X-Shazam-Platform': 'IPHONE',
  'X-Shazam-AppVersion': '14.1.0',
  Accept: '*/*',
  'Accept-Language': 'en-US',
  'Content-Type': 'application/json',
  'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 5.0.2; VS980 4G Build/LRX22G)',
};

const DEFAULT_TIMEOUT_MS = 30_000;

/** 12 秒的片段只會產生 1 個簽章，所以只取第一個 */
export const signFile: SignFile = async (file) => {
  const signatures = recognizeBytes(await readFile(file));
  try {
    const first = signatures[0];
    return first === undefined ? null : { uri: first.uri, samplems: first.samplems };
  } finally {
    for (const signature of signatures) {
      signature.free();
    }
  }
};

export function createShazamRecognizer(options: ShazamRecognizerOptions = {}): Recognizer {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sign = options.sign ?? signFile;
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async recognize(segmentFile, signal) {
      const signature = await sign(segmentFile);
      if (signature === null) {
        return null;
      }

      const url = URL_TEMPLATE.replace('{u1}', randomUUID().toUpperCase()).replace(
        '{u2}',
        randomUUID().toUpperCase(),
      );
      const timeout = AbortSignal.timeout(timeoutMs);
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({
          timezone: timeZone,
          signature,
          timestamp: Date.now(),
          context: {},
          geolocation: {},
        }),
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });

      // 限流時的回應是 text/html，沒有 Retry-After 標頭，只能靠狀態碼辨別
      if (response.status === 429) {
        throw new RateLimitedError();
      }
      if (!response.ok) {
        throw new Error(`Shazam 回應 HTTP ${response.status}`);
      }
      return parseShazamResponse(await response.json());
    },
  };
}

interface ShazamResponse {
  matches?: unknown[];
  track?: {
    key?: string;
    title?: string;
    subtitle?: string;
    url?: string;
    images?: { coverart?: string };
  };
}

/** `matches` 為空或沒有曲目資料時回傳無結果 */
export function parseShazamResponse(body: unknown): RecognizedTrack | null {
  const { matches, track } = (body ?? {}) as ShazamResponse;
  if (!Array.isArray(matches) || matches.length === 0 || track?.key === undefined) {
    return null;
  }
  return {
    trackId: track.key,
    artist: track.subtitle ?? '',
    title: track.title ?? '',
    shazamUrl: track.url ?? `https://www.shazam.com/track/${encodeURIComponent(track.key)}`,
    coverUrl: track.images?.coverart || null,
  };
}
