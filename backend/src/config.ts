/**
 * 集中管理後端的設定常數
 *
 * 取樣參數與伺服器設定都放在這裡，調整時只需要改這個檔案
 */

import path from 'node:path';
import type { AnalysisSettings } from './analysis-runner.ts';
import type { SegmentPlanOptions } from './segment-plan.ts';

// --- 伺服器 ---

/** 只綁定本機，區網內的其他裝置無法存取 */
export const HOST = '127.0.0.1';
export const PORT = 8765;

/** Angular build 後的靜態檔位置；不存在時後端只提供 API */
export const FRONTEND_DIST_DIR = path.resolve(
  import.meta.dirname,
  '../../frontend/dist/frontend/browser',
);

// --- 取樣與辨識 ---

/** 每個片段的長度（秒） */
export const SEGMENT_SECONDS = 12;

/** 相鄰片段起始時間的間隔（秒） */
export const STEP_SECONDS = 20;

/** 最後一段剩下的長度少於這個值時略過（秒） */
export const MIN_SEGMENT_SECONDS = 5;

/** 混音影片長度上限（秒），超過直接拒絕 */
export const MAX_DURATION_SECONDS = 3 * 60 * 60;

// Shazam 的限流以 IP 計算，2026-11-22 實測一開始可以連續送約 3 個請求，之後大約每 15～25 秒補 1 個名額
// （見 docs/spikes/2026-11-22-backend-runtime/README.md）。實際速度受限流決定，並行度提高也不會更快

/** 同時送往 Shazam 的辨識請求數 */
export const SHAZAM_CONCURRENCY = 2;

/** 單一片段遇到限流時的重試次數 */
export const SHAZAM_RETRY_ATTEMPTS = 6;

/** 限流後第一次重試前的冷卻時間（毫秒），之後每重試一次加倍：5、10、20、40、60、60 秒 */
export const SHAZAM_BACKOFF_BASE_MS = 5_000;

/** 單次冷卻時間的上限（毫秒） */
export const SHAZAM_BACKOFF_MAX_MS = 60_000;

/** 切段規劃使用的參數；預估片段數與實際切段共用 */
export const SEGMENT_PLAN: SegmentPlanOptions = {
  segmentSeconds: SEGMENT_SECONDS,
  stepSeconds: STEP_SECONDS,
  minSegmentSeconds: MIN_SEGMENT_SECONDS,
};

/** 分析任務使用的切段與辨識參數 */
export const ANALYSIS_SETTINGS: AnalysisSettings = {
  ...SEGMENT_PLAN,
  concurrency: SHAZAM_CONCURRENCY,
  retryAttempts: SHAZAM_RETRY_ATTEMPTS,
  backoffBaseMs: SHAZAM_BACKOFF_BASE_MS,
  backoffMaxMs: SHAZAM_BACKOFF_MAX_MS,
};
