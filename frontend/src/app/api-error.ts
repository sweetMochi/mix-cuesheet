import { HttpErrorResponse } from '@angular/common/http';

/** 後端回傳的錯誤，或前端轉換後的連線錯誤 */
export interface ApiError {
  code: string;
  /** 給使用者看的繁體中文訊息 */
  message: string;
  /** 原始錯誤；只有對應不到具體原因時才有資料 */
  detail?: string;
  /** 超過長度上限時附上影片長度 */
  durationText?: string;
}

export const BACKEND_UNREACHABLE: ApiError = {
  code: 'backend-unreachable',
  message: '無法連線到後端，請確認後端程序已經啟動',
};

/** 把 `HttpClient` 丟出的錯誤轉成 `ApiError` */
export function toApiError(error: unknown): ApiError {
  if (error instanceof HttpErrorResponse) {
    const body = error.error as { error?: Partial<ApiError> } | null;
    if (typeof body?.error?.message === 'string') {
      return body.error as ApiError;
    }
    if (error.status === 0 || error.status === 502 || error.status === 504) {
      return BACKEND_UNREACHABLE;
    }
    return {
      code: 'unexpected-response',
      message: '後端回傳了無法辨識的錯誤',
      detail: `HTTP ${error.status}`,
    };
  }
  return { code: 'unexpected-error', message: '發生未預期的錯誤', detail: String(error) };
}
