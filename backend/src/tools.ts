/** npm 套件提供的外部 CLI 工具 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
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
 * 中止時終止整個程序樹，等子程序結束後丟出 `AbortError`
 */
export function runTool(toolPath: string, args: readonly string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const child = spawn(toolPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    // 等子程序真的結束才回報中止，之後刪除暫存資料夾時檔案不會還被佔用
    child.on('close', (exitCode) => {
      signal?.removeEventListener('abort', onAbort);
      if (aborted) {
        reject(abortError());
      } else if (exitCode === 0) {
        resolve();
      } else {
        reject(new ToolExitError(toolPath, exitCode, stderr));
      }
    });
  });
}

function abortError(): Error {
  return new DOMException('外部工具已中止', 'AbortError');
}

/**
 * 終止子程序以及它啟動的所有子程序
 *
 * Windows 上終止一個程序不會連帶終止它的子程序；yt-dlp 的執行檔是 PyInstaller 打包的，
 * 啟動後會再開一個子程序執行，所以要以 `taskkill /T` 終止整個程序樹，否則會留下孤兒程序
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform !== 'win32') {
    child.kill('SIGTERM');
    return;
  }
  execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, (error) => {
    // 程序剛好自己結束時 taskkill 會失敗；仍在執行時至少終止這個程序本身
    if (error !== null && child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
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
