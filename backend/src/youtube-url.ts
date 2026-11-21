/** 驗證使用者貼上的 YouTube 網址，取出影片 ID */

/** 網址被拒絕的原因 */
export type UrlRejection =
  /** 不是網址，或不是 http／https */
  | 'invalid-format'
  /** 不是 YouTube 的網址 */
  | 'not-youtube'
  /** 只有播放清單，沒有指定影片 */
  | 'playlist-only'
  /** 是 YouTube 的網址，但找不到合法的影片 ID（例如頻道頁面） */
  | 'missing-video-id';

export type UrlParseResult = { ok: true; videoId: string } | { ok: false; reason: UrlRejection };

export const URL_REJECTION_MESSAGES: Record<UrlRejection, string> = {
  'invalid-format': '這不是有效的網址，請貼上完整的 YouTube 影片網址',
  'not-youtube': '目前只支援 YouTube 影片網址',
  'playlist-only': '這是播放清單的網址，目前只支援單一影片，請從清單中點開一支影片後再複製網址',
  'missing-video-id': '網址中找不到影片 ID，請貼上影片頁面的網址',
};

export const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be']);

/** 路徑直接帶影片 ID 的頁面，例如 `/live/<id>` */
const ID_IN_PATH_PATTERN = /^\/(?:live|embed|shorts)\/([^/]+)\/?$/;

/**
 * 從使用者貼上的字串取出影片 ID
 *
 * 接受 `youtube.com/watch?v=`、`youtu.be/` 與 `/live/` 等網址；帶 `list=` 的影片網址會忽略清單參數。
 * 沒有寫 `https://` 時自動補上
 */
export function parseYoutubeUrl(input: string): UrlParseResult {
  const url = toUrl(input.trim());
  if (url === null) {
    return { ok: false, reason: 'invalid-format' };
  }

  const host = url.hostname.toLowerCase();

  if (SHORT_HOSTS.has(host)) {
    return videoIdResult(url.pathname.slice(1).replace(/\/$/, ''), url);
  }

  if (!YOUTUBE_HOSTS.has(host)) {
    return { ok: false, reason: 'not-youtube' };
  }

  if (url.pathname === '/watch') {
    return videoIdResult(url.searchParams.get('v'), url);
  }

  const idInPath = ID_IN_PATH_PATTERN.exec(url.pathname);
  if (idInPath !== null) {
    return videoIdResult(idInPath[1], url);
  }

  return videoIdResult(null, url);
}

function toUrl(text: string): URL | null {
  if (text === '' || /\s/.test(text)) {
    return null;
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    const isWeb = url.protocol === 'http:' || url.protocol === 'https:';
    // 沒有點的主機名稱（例如隨手打的一個詞被補上 https://）不算網址
    return isWeb && url.hostname.includes('.') ? url : null;
  } catch {
    return null;
  }
}

function videoIdResult(candidate: string | null, url: URL): UrlParseResult {
  if (candidate !== null && VIDEO_ID_PATTERN.test(candidate)) {
    return { ok: true, videoId: candidate };
  }
  if (url.searchParams.has('list')) {
    return { ok: false, reason: 'playlist-only' };
  }
  return { ok: false, reason: 'missing-video-id' };
}

/** 依影片 ID 組出標準的影片網址 */
export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
