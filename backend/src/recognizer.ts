/**
 * 辨識器介面：輸入一個片段檔，回傳辨識到的曲目
 *
 * 任務執行器只依賴這個介面，替換辨識服務的實作時不需要動到任務執行器
 */

export interface RecognizedTrack {
  /** 辨識服務的曲目識別碼，用來判斷兩個片段是不是同一首 */
  trackId: string;
  artist: string;
  title: string;
  /** 曲目在 Shazam 的頁面 */
  shazamUrl: string;
  /** 封面網址；可能為空值 */
  coverUrl: string | null;
}

export interface Recognizer {
  /**
   * 辨識一個片段檔
   *
   * 沒有辨識到曲目時回傳空值；被限流時丟出 `RateLimitedError`；其他失敗丟出一般的錯誤
   */
  recognize(segmentFile: string, signal?: AbortSignal): Promise<RecognizedTrack | null>;
}

/** 辨識服務回報限流（HTTP 429）；呼叫端可以等一段時間後重試 */
export class RateLimitedError extends Error {
  constructor(message = '辨識服務暫時限流') {
    super(message);
    this.name = 'RateLimitedError';
  }
}
