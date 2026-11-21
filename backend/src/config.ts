/**
 * 集中管理後端的設定常數
 *
 * 取樣參數與伺服器設定都放在這裡，調整時只需要改這個檔案
 */

import path from 'node:path';

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

/** 混音影片長度上限（秒），超過直接拒絕 */
export const MAX_DURATION_SECONDS = 3 * 60 * 60;

/** 同時送往 Shazam 的辨識請求數 */
export const SHAZAM_CONCURRENCY = 2;

/** 遇到限流時的重試次數（指數退避） */
export const SHAZAM_RETRY_ATTEMPTS = 3;
