/**
 * 音訊來源介面：準備整支混音影片的音訊，再依起始秒數和長度切出片段檔
 *
 * 任務執行器只依賴這個介面，測試時可以換成假的實作
 */

import type { SegmentSpec } from './segment-plan.ts';

export interface AudioSource {
  /** 下載整支影片的音訊到任務暫存資料夾；失敗時丟出 `AudioSourceError` */
  prepare(videoId: string, workDir: string, signal?: AbortSignal): Promise<PreparedAudio>;
}

export interface PreparedAudio {
  /** 切出一個片段檔並回傳檔案路徑；失敗時丟出 `AudioSourceError` */
  extractSegment(segment: SegmentSpec, signal?: AbortSignal): Promise<string>;
}

export type AudioSourceErrorCode =
  /** 下載音訊失敗 */
  | 'download-failed'
  /** 切出片段失敗 */
  | 'split-failed'
  /** 找不到 yt-dlp 或 FFmpeg 的執行檔 */
  | 'tool-missing';

/** 音訊來源的錯誤；`message` 是給使用者看的繁體中文訊息 */
export class AudioSourceError extends Error {
  readonly code: AudioSourceErrorCode;
  /** 原始錯誤；只有對應不到具體原因時才有資料 */
  readonly detail: string | null;

  constructor(code: AudioSourceErrorCode, message: string, detail: string | null = null) {
    super(message);
    this.name = 'AudioSourceError';
    this.code = code;
    this.detail = detail;
  }
}
