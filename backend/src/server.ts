/** 以 `node src/server.ts` 啟動後端，主機與連接埠取自設定模組 */

import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createAnalysisJobs } from './analysis-jobs.ts';
import { runAnalysis } from './analysis-runner.ts';
import { createApp } from './app.ts';
import * as config from './config.ts';
import { createShazamRecognizer } from './shazam-recognizer.ts';
import { checkTools, readYtDlpVersion } from './tools.ts';
import { probeVideo } from './video-probe.ts';
import { ytDlpAudioSource } from './ytdlp-audio-source.ts';

const missing = checkTools()
  .filter((tool) => !tool.available)
  .map((tool) => tool.name);
if (missing.length > 0) {
  console.warn(`找不到 ${missing.join('、')} 的執行檔，請重新安裝後端依賴`);
}

const ytDlpVersion = await readYtDlpVersion();
console.log(`yt-dlp 版本：${ytDlpVersion ?? '無法取得'}`);

if (!existsSync(config.FRONTEND_DIST_DIR)) {
  console.warn('找不到前端 build 的檔案，只提供 API；開發時請另外執行 ng serve');
}

const recognizer = createShazamRecognizer();
const jobs = createAnalysisJobs((video) =>
  runAnalysis({
    video,
    settings: config.ANALYSIS_SETTINGS,
    audioSource: ytDlpAudioSource,
    recognizer,
  }),
);

const app = createApp({
  checkTools,
  ytDlpVersion,
  probeVideo,
  jobs,
  frontendDistDir: config.FRONTEND_DIST_DIR,
});

serve({ fetch: app.fetch, hostname: config.HOST, port: config.PORT }, (info) => {
  console.log(`後端已啟動，請用瀏覽器開啟 http://${config.HOST}:${info.port}/`);
  console.log('按 Ctrl+C 結束');
});
