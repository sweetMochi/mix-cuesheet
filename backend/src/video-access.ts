/**
 * 讀取影片時的錯誤，以及把 yt-dlp 的錯誤訊息轉成使用者看得懂的原因
 *
 * yt-dlp 不鎖定版本，錯誤訊息的文字可能改變；對應不到的錯誤一律歸為 `unknown`，並附上原始錯誤
 */

export type VideoAccessFailure =
  | 'members-only'
  | 'private'
  | 'login-required'
  | 'bot-check'
  | 'live-not-started'
  | 'live'
  | 'unavailable'
  | 'tool-missing'
  | 'unknown';

export const VIDEO_ACCESS_MESSAGES: Record<VideoAccessFailure, string> = {
  'members-only': '這支影片是頻道會員限定內容，無法讀取',
  private: '這支影片是私人影片，無法讀取',
  'login-required': '這支影片需要登入才能觀看（例如有年齡限制），無法讀取',
  'bot-check': 'YouTube 要求驗證不是機器人，請稍後再試',
  'live-not-started': '直播或首播尚未開始，無法分析',
  live: '這支影片是進行中的直播，請等直播結束後再分析',
  unavailable: '找不到這支影片，可能已被刪除，或網址中的影片 ID 有誤',
  'tool-missing': '找不到 yt-dlp 的執行檔，請關閉後端，執行「start.ps1 -Rebuild」重新安裝依賴',
  unknown: '無法讀取影片資訊，請重新啟動 App 讓 yt-dlp 自動更新後再試',
};

export class VideoAccessError extends Error {
  readonly reason: VideoAccessFailure;
  /** yt-dlp 的原始錯誤；對應不到具體原因時附給使用者參考 */
  readonly detail: string | null;

  constructor(reason: VideoAccessFailure, detail: string | null = null) {
    super(VIDEO_ACCESS_MESSAGES[reason]);
    this.name = 'VideoAccessError';
    this.reason = reason;
    this.detail = detail;
  }
}

/** 依序比對，越具體的規則越前面 */
const RULES: readonly [VideoAccessFailure, RegExp][] = [
  ['members-only', /members[- ]only|join this channel|available to this channel's members/i],
  ['private', /private video|this video is private/i],
  ['bot-check', /not a bot/i],
  ['login-required', /confirm your age|age[- ]restricted|inappropriate for some users|sign in to view/i],
  ['live-not-started', /live event will begin|premieres in|premiere will begin/i],
  [
    'unavailable',
    /video (?:is )?unavailable|video is (?:not|no longer) available|has been removed|been terminated|does not exist|incomplete youtube id|http error 404/i,
  ],
];

/** 把 yt-dlp 的 stderr 轉成讀取影片的錯誤 */
export function classifyYtDlpError(stderr: string): VideoAccessError {
  const message = extractErrorMessage(stderr);
  for (const [reason, pattern] of RULES) {
    if (pattern.test(message)) {
      return new VideoAccessError(reason, message);
    }
  }
  return new VideoAccessError('unknown', message || null);
}

/** 取出最後一行 `ERROR:` 訊息；沒有時取最後一行非空白的輸出 */
function extractErrorMessage(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const errorLines = lines.filter((line) => line.startsWith('ERROR:'));
  return errorLines.at(-1) ?? lines.at(-1) ?? '';
}
