/** 以 yt-dlp 讀取影片資訊（不下載） */

import { execFile } from 'node:child_process';
import { classifyYtDlpError, VideoAccessError } from './video-access.ts';
import { watchUrl } from './youtube-url.ts';
import { FFMPEG_PATH, YT_DLP_PATH } from './tools.ts';

export interface VideoInfo {
  videoId: string;
  title: string;
  /** 影片長度（秒） */
  durationSeconds: number;
}

/** 讀取影片資訊；失敗時丟出 `VideoAccessError` */
export type ProbeVideo = (videoId: string, signal?: AbortSignal) => Promise<VideoInfo>;

/**
 * 每次呼叫 yt-dlp 都要帶的參數：以 Node.js 處理 YouTube 的 JS challenge，並指定 FFmpeg 的位置
 */
export function ytDlpCommonArgs(): string[] {
  const args = ['--no-js-runtimes', '--js-runtimes', `node:${process.execPath}`];
  if (FFMPEG_PATH !== null) {
    args.push('--ffmpeg-location', FFMPEG_PATH);
  }
  return args;
}

const PROBE_TIMEOUT_MS = 60_000;

/** `--dump-json` 會列出所有格式，輸出可能有好幾 MB */
const PROBE_MAX_BUFFER = 64 * 1024 * 1024;

export const probeVideo: ProbeVideo = async (videoId, signal) => {
  const args = [
    ...ytDlpCommonArgs(),
    '--dump-json',
    '--skip-download',
    '--no-playlist',
    '--no-warnings',
    watchUrl(videoId),
  ];

  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      YT_DLP_PATH,
      args,
      { encoding: 'utf8', maxBuffer: PROBE_MAX_BUFFER, timeout: PROBE_TIMEOUT_MS, signal, windowsHide: true },
      (error, out, stderr) => {
        if (error === null) {
          resolve(out);
        } else if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new VideoAccessError('tool-missing'));
        } else if (error.name === 'AbortError') {
          reject(error);
        } else {
          reject(classifyYtDlpError(stderr || error.message));
        }
      },
    );
  });

  return parseVideoInfo(videoId, stdout);
};

interface YtDlpInfo {
  id?: string;
  title?: string;
  duration?: number | null;
  is_live?: boolean | null;
  live_status?: string | null;
}

function parseVideoInfo(videoId: string, stdout: string): VideoInfo {
  let info: YtDlpInfo;
  try {
    info = JSON.parse(stdout) as YtDlpInfo;
  } catch {
    throw new VideoAccessError('unknown', 'yt-dlp 的輸出不是有效的 JSON');
  }

  if (info.is_live === true || info.live_status === 'is_live') {
    throw new VideoAccessError('live');
  }
  if (info.live_status === 'is_upcoming') {
    throw new VideoAccessError('live-not-started');
  }
  if (typeof info.duration !== 'number' || !(info.duration > 0)) {
    throw new VideoAccessError('unknown', 'yt-dlp 沒有回傳影片長度');
  }

  return {
    videoId: info.id ?? videoId,
    title: info.title ?? '',
    durationSeconds: info.duration,
  };
}
