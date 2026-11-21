import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiError, toApiError } from './api-error';

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

export type ProbeState =
  | { status: 'idle' }
  | { status: 'probing' }
  | { status: 'ready'; video: VideoProbe }
  | { status: 'failed'; error: ApiError };

@Injectable({ providedIn: 'root' })
export class VideoProbeService {
  private readonly http = inject(HttpClient);

  /** 讀取影片資訊（不下載）；失敗時丟出 `ApiError` */
  async probe(url: string): Promise<VideoProbe> {
    try {
      return await firstValueFrom(this.http.post<VideoProbe>('/api/videos/probe', { url }));
    } catch (error) {
      throw toApiError(error);
    }
  }
}
