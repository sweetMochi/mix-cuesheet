import { httpResource } from '@angular/common/http';

export interface ToolStatus {
  name: string;
  available: boolean;
}

export interface HealthResponse {
  ok: boolean;
  tools: ToolStatus[];
}

/** 向後端查詢 yt-dlp 與 FFmpeg 是否可用 */
export function healthResource() {
  return httpResource<HealthResponse>(() => '/api/health');
}
