import { describe, expect, it } from 'vitest';
import { classifyYtDlpError } from '../src/video-access.ts';

describe('classifyYtDlpError', () => {
  it.each([
    [
      'members-only',
      'ERROR: [youtube] abcdefghijk: Join this channel to get access to members-only content like this video, and other exclusive perks.',
    ],
    [
      'members-only',
      "ERROR: [youtube] abcdefghijk: This video is available to this channel's members on level: Tier 1 (or any higher level).",
    ],
    [
      'private',
      "ERROR: [youtube] abcdefghijk: Private video. Sign in if you've been granted access to this video",
    ],
    [
      'login-required',
      'ERROR: [youtube] abcdefghijk: Sign in to confirm your age. This video may be inappropriate for some users.',
    ],
    [
      'bot-check',
      "ERROR: [youtube] abcdefghijk: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.",
    ],
    ['live-not-started', 'ERROR: [youtube] abcdefghijk: This live event will begin in 3 hours.'],
    ['live-not-started', 'ERROR: [youtube] abcdefghijk: Premieres in 2 days'],
    ['unavailable', 'ERROR: [youtube] abcdefghijk: Video unavailable'],
    // yt-dlp 2026.10.26 對不存在的影片 ID 實際回傳的訊息
    ['unavailable', 'ERROR: [youtube] aaaaaaaaaaa: This video is unavailable'],
    [
      'unavailable',
      'ERROR: [youtube] abcdefghijk: Video unavailable. This video has been removed by the uploader',
    ],
    [
      'unavailable',
      'ERROR: [youtube] abcdefghijk: Video unavailable. This video is no longer available because the YouTube account associated with this video has been terminated.',
    ],
  ])('%s：%s', (reason, stderr) => {
    const error = classifyYtDlpError(stderr);

    expect(error.reason).toBe(reason);
    expect(error.message).not.toBe('');
  });

  it('取最後一行 ERROR，忽略前面的一般輸出與警告', () => {
    const stderr = [
      '[youtube] Extracting URL: https://www.youtube.com/watch?v=abcdefghijk',
      'WARNING: [youtube] Some formats may be missing',
      "ERROR: [youtube] abcdefghijk: Private video. Sign in if you've been granted access to this video",
      '',
    ].join('\r\n');

    expect(classifyYtDlpError(stderr).reason).toBe('private');
  });

  it('對應不到的錯誤歸為 unknown，並附上原始錯誤', () => {
    const stderr = 'ERROR: [youtube] abcdefghijk: Something completely new happened';

    const error = classifyYtDlpError(stderr);

    expect(error.reason).toBe('unknown');
    expect(error.detail).toBe(stderr);
  });

  it('沒有 ERROR 行時以最後一行輸出當作原始錯誤', () => {
    const error = classifyYtDlpError('Traceback (most recent call last):\n  boom\n');

    expect(error.reason).toBe('unknown');
    expect(error.detail).toBe('boom');
  });

  it('沒有任何輸出時原始錯誤為空值', () => {
    expect(classifyYtDlpError('').detail).toBeNull();
  });
});
