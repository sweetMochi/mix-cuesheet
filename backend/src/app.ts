import { existsSync } from 'node:fs';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { AnalysisJobs } from './analysis-jobs.ts';
import * as config from './config.ts';
import { planSegments } from './segment-plan.ts';
import { formatTimestamp } from './timestamp.ts';
import type { ToolStatus } from './tools.ts';
import { VideoAccessError, type VideoAccessFailure } from './video-access.ts';
import type { ProbeVideo, VideoInfo } from './video-probe.ts';
import { parseYoutubeUrl, URL_REJECTION_MESSAGES, VIDEO_ID_PATTERN, type UrlRejection } from './youtube-url.ts';

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

export interface CreateJobResponse {
  jobId: string;
}

export type ProbeErrorCode = 'bad-request' | 'not-found' | UrlRejection | VideoAccessFailure | 'too-long';

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
  jobs: AnalysisJobs;
  /** Angular build 後的靜態檔位置；空值或資料夾不存在時只提供 API */
  frontendDistDir: string | null;
}

const probeRequestSchema = z.object({ url: z.string() });

const createJobRequestSchema = z.object({ videoId: z.string().regex(VIDEO_ID_PATTERN) });

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
      return errorResponse(c, 400, 'bad-request', '請求格式錯誤，必須包含 url 欄位');
    }

    const parsed = parseYoutubeUrl(body.data.url);
    if (!parsed.ok) {
      return errorResponse(c, 400, parsed.reason, URL_REJECTION_MESSAGES[parsed.reason]);
    }

    const video = await readAnalyzableVideo(c, deps.probeVideo, parsed.videoId);
    if (video instanceof Response) {
      return video;
    }

    return c.json<ProbeResponse>({
      videoId: video.videoId,
      title: video.title,
      durationSeconds: video.durationSeconds,
      durationText: formatTimestamp(video.durationSeconds),
      segmentCount: planSegments(video.durationSeconds, config.SEGMENT_PLAN).length,
    });
  });

  app.post('/api/jobs', async (c) => {
    const body = createJobRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return errorResponse(c, 400, 'bad-request', '請求格式錯誤，必須包含合法的 videoId 欄位');
    }

    // 重新讀取影片資訊，以 yt-dlp 回報的長度切段，不採信用戶端傳來的資料
    const video = await readAnalyzableVideo(c, deps.probeVideo, body.data.videoId);
    if (video instanceof Response) {
      return video;
    }

    return c.json<CreateJobResponse>({ jobId: deps.jobs.start(video) }, 201);
  });

  app.get('/api/jobs/:jobId/events', (c) => {
    const subscription = new AbortController();
    const events = deps.jobs.events(c.req.param('jobId'), subscription.signal);
    if (events === null) {
      return errorResponse(c, 404, 'not-found', '找不到這個分析任務，可能已經結束太久，請重新開始分析');
    }

    return streamSSE(c, async (stream) => {
      stream.onAbort(() => subscription.abort());
      for await (const event of events) {
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      }
    });
  });

  // 平常使用時由後端直接提供 Angular build 後的靜態檔；開發時改用 ng serve
  if (deps.frontendDistDir !== null && existsSync(deps.frontendDistDir)) {
    app.use('/*', serveStatic({ root: deps.frontendDistDir }));
  }

  return app;
}

function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
  code: ProbeErrorCode,
  message: string,
  extra: Omit<ApiErrorResponse['error'], 'code' | 'message'> = {},
): Response {
  return c.json<ApiErrorResponse>({ error: { code, message, ...extra } }, status);
}

/**
 * 以 yt-dlp 讀取影片資訊，並確認長度沒有超過上限
 *
 * 影片無法讀取或太長時回傳錯誤回應
 */
async function readAnalyzableVideo(
  c: Context,
  probeVideo: ProbeVideo,
  videoId: string,
): Promise<VideoInfo | Response> {
  let video: VideoInfo;
  try {
    video = await probeVideo(videoId, c.req.raw.signal);
  } catch (error) {
    if (!(error instanceof VideoAccessError)) {
      throw error;
    }
    return errorResponse(
      c,
      VIDEO_ACCESS_STATUS[error.reason],
      error.reason,
      error.message,
      error.reason === 'unknown' && error.detail !== null ? { detail: error.detail } : {},
    );
  }

  if (video.durationSeconds > config.MAX_DURATION_SECONDS) {
    const durationText = formatTimestamp(video.durationSeconds);
    const limitHours = config.MAX_DURATION_SECONDS / 3600;
    return errorResponse(c, 422, 'too-long', `影片長度 ${durationText} 超過 ${limitHours} 小時的上限，無法分析`, {
      durationSeconds: video.durationSeconds,
      durationText,
    });
  }

  return video;
}
