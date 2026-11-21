import { existsSync } from 'node:fs';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import * as config from './config.ts';
import { planSegments } from './segment-plan.ts';
import { formatTimestamp } from './timestamp.ts';
import type { ToolStatus } from './tools.ts';
import { VideoAccessError, type VideoAccessFailure } from './video-access.ts';
import type { ProbeVideo } from './video-probe.ts';
import { parseYoutubeUrl, URL_REJECTION_MESSAGES, type UrlRejection } from './youtube-url.ts';

export interface HealthResponse {
  ok: boolean;
  tools: ToolStatus[];
  /** 啟動時取得的 yt-dlp 版本；無法取得時為空值 */
  ytDlpVersion: string | null;
}

export interface ProbeResponse {
  videoId: string;
  title: string;
  durationSeconds: number;
  /** 格式化後的影片長度，例如 `1:02:03` */
  durationText: string;
  /** 預估片段數，與實際切段使用同一套計算 */
  segmentCount: number;
}

export type ProbeErrorCode = 'bad-request' | UrlRejection | VideoAccessFailure | 'too-long';

export interface ApiErrorResponse {
  error: {
    code: ProbeErrorCode;
    /** 給使用者看的繁體中文訊息 */
    message: string;
    /** 原始錯誤；只有對應不到具體原因時才有資料 */
    detail?: string;
    /** 超過長度上限時附上影片長度 */
    durationSeconds?: number;
    durationText?: string;
  };
}

export interface AppDeps {
  checkTools: () => ToolStatus[];
  ytDlpVersion: string | null;
  probeVideo: ProbeVideo;
  /** Angular build 後的靜態檔位置；空值或資料夾不存在時只提供 API */
  frontendDistDir: string | null;
}

const probeRequestSchema = z.object({ url: z.string() });

/** 讀取影片失敗時的 HTTP 狀態碼 */
const VIDEO_ACCESS_STATUS: Record<VideoAccessFailure, ContentfulStatusCode> = {
  'members-only': 422,
  private: 422,
  'login-required': 422,
  'bot-check': 503,
  'live-not-started': 422,
  live: 422,
  unavailable: 422,
  'tool-missing': 500,
  unknown: 502,
};

/** 建立 Hono app；相依由外部注入，測試時不需要啟動伺服器 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get('/api/health', (c) => {
    const tools = deps.checkTools();
    return c.json<HealthResponse>({
      ok: tools.every((tool) => tool.available),
      tools,
      ytDlpVersion: deps.ytDlpVersion,
    });
  });

  app.post('/api/videos/probe', async (c) => {
    const body = probeRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json<ApiErrorResponse>(
        { error: { code: 'bad-request', message: '請求格式錯誤，必須包含 url 欄位' } },
        400,
      );
    }

    const parsed = parseYoutubeUrl(body.data.url);
    if (!parsed.ok) {
      return c.json<ApiErrorResponse>(
        { error: { code: parsed.reason, message: URL_REJECTION_MESSAGES[parsed.reason] } },
        400,
      );
    }

    let video;
    try {
      video = await deps.probeVideo(parsed.videoId, c.req.raw.signal);
    } catch (error) {
      if (!(error instanceof VideoAccessError)) {
        throw error;
      }
      return c.json<ApiErrorResponse>(
        {
          error: {
            code: error.reason,
            message: error.message,
            ...(error.reason === 'unknown' && error.detail !== null ? { detail: error.detail } : {}),
          },
        },
        VIDEO_ACCESS_STATUS[error.reason],
      );
    }

    const durationText = formatTimestamp(video.durationSeconds);
    if (video.durationSeconds > config.MAX_DURATION_SECONDS) {
      const limitHours = config.MAX_DURATION_SECONDS / 3600;
      return c.json<ApiErrorResponse>(
        {
          error: {
            code: 'too-long',
            message: `影片長度 ${durationText} 超過 ${limitHours} 小時的上限，無法分析`,
            durationSeconds: video.durationSeconds,
            durationText,
          },
        },
        422,
      );
    }

    const segments = planSegments(video.durationSeconds, {
      segmentSeconds: config.SEGMENT_SECONDS,
      stepSeconds: config.STEP_SECONDS,
      minSegmentSeconds: config.MIN_SEGMENT_SECONDS,
    });

    return c.json<ProbeResponse>({
      videoId: video.videoId,
      title: video.title,
      durationSeconds: video.durationSeconds,
      durationText,
      segmentCount: segments.length,
    });
  });

  // 平常使用時由後端直接提供 Angular build 後的靜態檔；開發時改用 ng serve
  if (deps.frontendDistDir !== null && existsSync(deps.frontendDistDir)) {
    app.use('/*', serveStatic({ root: deps.frontendDistDir }));
  }

  return app;
}
