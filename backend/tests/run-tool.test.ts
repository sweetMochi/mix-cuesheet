import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTool, ToolExitError } from '../src/tools.ts';

/**
 * 啟動一個不會自己結束的子程序（孫程序），把它的 PID 寫進檔案後一直執行
 *
 * Node 在 Windows 上會把子程序放進 job object，父程序結束時子程序跟著結束；
 * 以 `detached` 啟動才不會被放進去，和 yt-dlp（PyInstaller）留下孤兒程序的情況一樣
 */
const SPAWN_GRANDCHILD = `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
writeFileSync(process.argv[1], String(child.pid));
setInterval(() => {}, 1000);
`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let tempDir: string;
let grandchildPid: number | null = null;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'mix-cuesheet-run-tool-'));
});

afterEach(async () => {
  // 測試失敗時不要留下孤兒程序
  if (grandchildPid !== null && isAlive(grandchildPid)) {
    process.kill(grandchildPid);
  }
  grandchildPid = null;
  await rm(tempDir, { recursive: true, force: true });
});

describe('runTool', () => {
  it('結束代碼不是 0 時丟出 ToolExitError，附上 stderr', async () => {
    const error = await runTool(process.execPath, ['-e', 'console.error("boom"); process.exit(3)']).catch(
      (error: unknown) => error,
    );

    expect(error).toBeInstanceOf(ToolExitError);
    expect(error).toMatchObject({ exitCode: 3, stderr: expect.stringContaining('boom') });
  });

  it('中止時終止整個程序樹，等子程序結束後丟出 AbortError', async () => {
    const pidFile = path.join(tempDir, 'grandchild.pid');
    const controller = new AbortController();
    const running = runTool(process.execPath, ['-e', SPAWN_GRANDCHILD, pidFile], controller.signal);
    running.catch(() => {});

    await vi.waitFor(() => expect(existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '').toBe(true), {
      timeout: 10_000,
    });
    grandchildPid = Number(readFileSync(pidFile, 'utf8'));
    expect(isAlive(grandchildPid)).toBe(true);

    controller.abort();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(isAlive(grandchildPid!)).toBe(false), { timeout: 5_000 });
  });

  it('已經中止的信號不會啟動子程序', async () => {
    const marker = path.join(tempDir, 'started');

    await expect(
      runTool(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`], AbortSignal.abort()),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(existsSync(marker)).toBe(false);
  });
});
