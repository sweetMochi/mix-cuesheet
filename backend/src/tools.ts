/** npm 套件提供的外部 CLI 工具 */

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
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

/** 工具以非 0 的結束代碼結束 */
export class ToolExitError extends Error {
  readonly exitCode: number | null;
  /** stderr 的最後一部分 */
  readonly stderr: string;

  constructor(toolPath: string, exitCode: number | null, stderr: string) {
    super(`${path.basename(toolPath)} 結束代碼 ${exitCode}：${stderr.trim().split(/\r?\n/).at(-1) ?? ''}`);
    this.name = 'ToolExitError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** stderr 只保留最後這麼多字元，避免長時間執行的子程序佔用太多記憶體 */
const STDERR_TAIL_CHARS = 64 * 1024;

/**
 * 執行外部工具直到結束，不讀取 stdout
 *
 * 結束代碼不是 0 時丟出 `ToolExitError`；執行檔不存在時丟出 `code` 為 `ENOENT` 的錯誤；
 * 中止時終止子程序並丟出 `AbortError`
 */
export function runTool(toolPath: string, args: readonly string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(toolPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      signal,
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      if (exitCode === 0) {
        resolve();
      } else {
        reject(new ToolExitError(toolPath, exitCode, stderr));
      }
    });
  });
}

export function isMissingExecutable(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
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
