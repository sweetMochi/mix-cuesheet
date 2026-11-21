import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

/** 預先解析成功時，後端回傳的影片資訊 */
export interface VideoProbe {
  videoId: string;
  title: string;
  durationSeconds: number;
  /** 後端格式化好的影片長度，例如 `1:02:03` */
  durationText: string;
  /** 預估片段數，與實際切段使用同一套計算 */
  segmentCount: number;
}

/** 後端回傳的錯誤 */
export interface ProbeError {
  code: string;
  /** 給使用者看的繁體中文訊息 */
  message: string;
  /** 原始錯誤；只有對應不到具體原因時才有資料 */
  detail?: string;
  /** 超過長度上限時附上影片長度 */
  durationText?: string;
}

export type ProbeState =
  | { status: 'idle' }
  | { status: 'probing' }
  | { status: 'ready'; video: VideoProbe }
  | { status: 'failed'; error: ProbeError };

const BACKEND_UNREACHABLE: ProbeError = {
  code: 'backend-unreachable',
  message: '無法連線到後端，請確認後端程序已經啟動',
};

@Injectable({ providedIn: 'root' })
export class VideoProbeService {
  private readonly http = inject(HttpClient);

  /** 讀取影片資訊（不下載）；失敗時丟出 `ProbeError` */
  async probe(url: string): Promise<VideoProbe> {
    try {
      return await firstValueFrom(this.http.post<VideoProbe>('/api/videos/probe', { url }));
    } catch (error) {
      throw toProbeError(error);
    }
  }
}

function toProbeError(error: unknown): ProbeError {
  if (error instanceof HttpErrorResponse) {
    const body = error.error as { error?: Partial<ProbeError> } | null;
    if (typeof body?.error?.message === 'string') {
      return body.error as ProbeError;
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
