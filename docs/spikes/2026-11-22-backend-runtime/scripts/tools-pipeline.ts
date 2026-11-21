// 實驗：只用 npm 套件提供的 yt-dlp 與 FFmpeg，跑一次「預先解析 → 下載音訊 → 切出片段」
// 子程序的 PATH 只保留 Node.js 與 Windows 系統資料夾，確保不會用到 WinGet 安裝的工具
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';

const require = createRequire(import.meta.url);
const { YOUTUBE_DL_PATH: ytDlpPath } = require('youtube-dl-exec/src/constants');

const VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const NODE_DIR = path.dirname(process.execPath);
const env = {
  ...process.env,
  PATH: [NODE_DIR, 'C:\\Windows\\System32', 'C:\\Windows'].join(';'),
};

function run(cmd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(cmd, args, { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Math.round(performance.now() - started) }));
  });
}

const interesting = (log: string) =>
  log
    .split(/\r?\n/)
    .filter((l) => /JS runtimes|jsc|challenge|WARNING|ERROR|ffmpeg|Signature|formats may be missing/i.test(l))
    .map((l) => '    ' + l)
    .join('\n');

console.log(`ffmpeg-static：${ffmpegPath}`);
console.log(`yt-dlp：${ytDlpPath}`);
console.log(`子程序 PATH：${env.PATH}\n`);

// 1. 版本
const ff = await run(ffmpegPath!, ['-version']);
console.log(`[1] FFmpeg：${ff.stdout.split('\n')[0]}`);
const yv = await run(ytDlpPath, ['--version']);
console.log(`[1] yt-dlp：${yv.stdout.trim()}\n`);

// 2. 對照組：不啟用任何 JS runtime
const none = await run(ytDlpPath, ['-v', '--no-js-runtimes', '--simulate', '-f', 'bestaudio', VIDEO]);
console.log(`[2] 不啟用 JS runtime：結束代碼 ${none.code}，${none.ms} ms`);
console.log(interesting(none.stderr) + '\n');

// 3. 預先解析：用 Node 當 JS runtime
const probe = await run(ytDlpPath, [
  '-v', '--no-js-runtimes', '--js-runtimes', `node:${process.execPath}`,
  '--dump-json', '--no-playlist', VIDEO,
]);
console.log(`[3] 用 Node 當 JS runtime 預先解析：結束代碼 ${probe.code}，${probe.ms} ms`);
console.log(interesting(probe.stderr));
if (probe.code === 0) {
  const info = JSON.parse(probe.stdout);
  const audio = info.formats.filter((f: any) => f.vcodec === 'none' && f.acodec !== 'none');
  console.log(`    標題：${info.title}，長度：${info.duration} 秒，純音訊格式數：${audio.length}`);
}
console.log();

// 4. 下載整支影片的最佳音質音訊
const workDir = mkdtempSync(path.join(tmpdir(), 'mix-cuesheet-spike-'));
const dl = await run(ytDlpPath, [
  '--no-js-runtimes', '--js-runtimes', `node:${process.execPath}`,
  '--ffmpeg-location', ffmpegPath!,
  '-f', 'bestaudio', '--no-playlist', '-o', path.join(workDir, 'audio.%(ext)s'), VIDEO,
]);
const files = readdirSync(workDir);
console.log(`[4] 下載音訊：結束代碼 ${dl.code}，${dl.ms} ms，檔案：${files.map((f) => `${f}（${statSync(path.join(workDir, f)).size} bytes）`).join('、')}`);
if (dl.code !== 0) console.log(interesting(dl.stderr));

// 5. 用 ffmpeg-static 切出第 60 秒起的 12 秒片段（單聲道、16 kHz）
const audioFile = path.join(workDir, files[0]);
const clip = path.join(workDir, 'clip-60.wav');
const cut = await run(ffmpegPath!, ['-v', 'error', '-y', '-ss', '60', '-t', '12', '-i', audioFile, '-ac', '1', '-ar', '16000', clip]);
const check = await run(ffmpegPath!, ['-hide_banner', '-i', clip]);
const durationLine = check.stderr.split('\n').find((l) => l.includes('Duration')) ?? '';
const streamLine = check.stderr.split('\n').find((l) => l.includes('Audio:')) ?? '';
console.log(`[5] 切段：結束代碼 ${cut.code}，${cut.ms} ms`);
console.log(`    ${durationLine.trim()}`);
console.log(`    ${streamLine.trim()}`);
console.log(`\n片段位置：${clip}`);
