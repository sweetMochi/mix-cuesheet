import { describe, expect, it } from 'vitest';
import { parseYoutubeUrl } from '../src/youtube-url.ts';

const ID = 'dQw4w9WgXcQ';

describe('parseYoutubeUrl 接受的網址', () => {
  it.each([
    [`https://www.youtube.com/watch?v=${ID}`],
    [`https://youtube.com/watch?v=${ID}`],
    [`https://m.youtube.com/watch?v=${ID}`],
    [`https://music.youtube.com/watch?v=${ID}`],
    [`http://www.youtube.com/watch?v=${ID}`],
    [`https://www.youtube.com/watch?v=${ID}&t=120s`],
    [`https://www.youtube.com/watch?feature=share&v=${ID}`],
    [`https://youtu.be/${ID}`],
    [`https://youtu.be/${ID}?si=abcdef&t=30`],
    [`https://www.youtube.com/live/${ID}`],
    [`https://www.youtube.com/embed/${ID}`],
    [`www.youtube.com/watch?v=${ID}`],
    [`youtu.be/${ID}`],
    [`  https://youtu.be/${ID}  `],
  ])('%s', (input) => {
    expect(parseYoutubeUrl(input)).toEqual({ ok: true, videoId: ID });
  });

  it('帶 list= 的影片網址只取影片 ID，忽略清單參數', () => {
    const input = `https://www.youtube.com/watch?v=${ID}&list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG&index=3`;

    expect(parseYoutubeUrl(input)).toEqual({ ok: true, videoId: ID });
  });

  it('youtu.be 短網址帶 list= 時也只取影片 ID', () => {
    const input = `https://youtu.be/${ID}?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG`;

    expect(parseYoutubeUrl(input)).toEqual({ ok: true, videoId: ID });
  });
});

describe('parseYoutubeUrl 拒絕的網址', () => {
  it.each([
    ['https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG'],
    ['https://youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG'],
    ['https://www.youtube.com/watch?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG'],
  ])('純播放清單：%s', (input) => {
    expect(parseYoutubeUrl(input)).toEqual({ ok: false, reason: 'playlist-only' });
  });

  it.each([
    [`https://vimeo.com/${ID}`],
    [`https://www.youtube.com.evil.example/watch?v=${ID}`],
    [`https://notyoutube.com/watch?v=${ID}`],
    ['https://soundcloud.com/some-dj/some-mix'],
  ])('非 YouTube：%s', (input) => {
    expect(parseYoutubeUrl(input)).toEqual({ ok: false, reason: 'not-youtube' });
  });

  it.each([
    [''],
    ['   '],
    ['不是網址'],
    ['hello world'],
    ['https://'],
    ['ftp://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['javascript:alert(1)'],
  ])('格式錯誤：%j', (input) => {
    expect(parseYoutubeUrl(input)).toEqual({ ok: false, reason: 'invalid-format' });
  });

  it.each([
    ['https://www.youtube.com/'],
    ['https://www.youtube.com/@SomeChannel'],
    ['https://www.youtube.com/watch'],
    ['https://www.youtube.com/watch?v=tooShort'],
    [`https://www.youtube.com/watch?v=${ID}extra`],
    ['https://www.youtube.com/watch?v=dQw4w9WgXc!'],
    ['https://youtu.be/'],
  ])('找不到合法的影片 ID：%s', (input) => {
    expect(parseYoutubeUrl(input)).toEqual({ ok: false, reason: 'missing-video-id' });
  });
});
