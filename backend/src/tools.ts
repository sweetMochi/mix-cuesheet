/** npm 套件提供的外部 CLI 工具 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);

/** `youtube-dl-exec` 安裝時下載的 yt-dlp 執行檔 */
export const YT_DLP_PATH: string = (
  require('youtube-dl-exec/src/constants') as { YOUTUBE_DL_PATH: string }
).YOUTUBE_DL_PATH;

/** `ffmpeg-static` 安裝時下載的 FFmpeg 執行檔；套件不支援目前的平台時為空值 */
export const FFMPEG_PATH: string | null = require('ffmpeg-static') as string | null;

export interface Tool {
  name: string;
  path: string | null;
}

export interface ToolStatus {
  name: string;
  available: boolean;
}

export const TOOLS: readonly Tool[] = [
  { name: 'yt-dlp', path: YT_DLP_PATH },
  { name: 'FFmpeg', path: FFMPEG_PATH },
];

/** 確認每個工具的執行檔都存在；安裝腳本沒有執行或下載失敗時，執行檔可能不存在 */
export function checkTools(
  tools: readonly Tool[] = TOOLS,
  exists: (path: string) => boolean = existsSync,
): ToolStatus[] {
  return tools.map((tool) => ({
    name: tool.name,
    available: tool.path !== null && exists(tool.path),
  }));
}

const execFileAsync = promisify(execFile);

/** 取得 yt-dlp 的版本；執行檔不存在或無法執行時回傳空值 */
export async function readYtDlpVersion(ytDlpPath: string = YT_DLP_PATH): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(ytDlpPath, ['--version'], { timeout: 30_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
