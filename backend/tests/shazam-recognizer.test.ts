import { describe, expect, it } from 'vitest';
import { RateLimitedError } from '../src/recognizer.ts';
import { createShazamRecognizer } from '../src/shazam-recognizer.ts';

const signature = { uri: 'data:audio/vnd.shazam.sig;base64,AAAA', samplems: 11991 };

function recognizerResponding(response: Response) {
  return createShazamRecognizer({
    sign: async () => signature,
    fetch: async () => response,
    timeZone: 'Asia/Taipei',
  });
}

describe('createShazamRecognizer', () => {
  it('回傳曲目識別碼、演出者、曲名、Shazam 連結與封面網址', async () => {
    const recognizer = recognizerResponding(
      Response.json({
        matches: [{ id: '1' }],
        track: {
          key: '5933917',
          title: 'Never Gonna Give You Up',
          subtitle: 'Rick Astley',
          url: 'https://www.shazam.com/track/5933917/never-gonna-give-you-up',
          images: { coverart: 'https://is1-ssl.mzstatic.com/cover.jpg' },
        },
      }),
    );

    expect(await recognizer.recognize('segment-0.wav')).toEqual({
      trackId: '5933917',
      artist: 'Rick Astley',
      title: 'Never Gonna Give You Up',
      shazamUrl: 'https://www.shazam.com/track/5933917/never-gonna-give-you-up',
      coverUrl: 'https://is1-ssl.mzstatic.com/cover.jpg',
    });
  });

  it('沒有封面時封面網址為空值', async () => {
    const recognizer = recognizerResponding(
      Response.json({ matches: [{}], track: { key: '1', title: 'T', subtitle: 'A', url: 'https://x' } }),
    );

    expect((await recognizer.recognize('segment-0.wav'))?.coverUrl).toBeNull();
  });

  it('matches 為空時回傳無結果', async () => {
    const recognizer = recognizerResponding(Response.json({ matches: [], tagid: 'abc' }));

    expect(await recognizer.recognize('segment-0.wav')).toBeNull();
  });

  it('無法產生簽章時回傳無結果，不送出請求', async () => {
    let requested = false;
    const recognizer = createShazamRecognizer({
      sign: async () => null,
      fetch: async () => {
        requested = true;
        return Response.json({});
      },
    });

    expect(await recognizer.recognize('segment-0.wav')).toBeNull();
    expect(requested).toBe(false);
  });

  it('HTTP 429 時丟出限流錯誤', async () => {
    const recognizer = recognizerResponding(
      new Response('<html>429 Too Many Requests</html>', { status: 429, headers: { 'Content-Type': 'text/html' } }),
    );

    await expect(recognizer.recognize('segment-0.wav')).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('其他錯誤狀態碼丟出一般錯誤', async () => {
    const recognizer = recognizerResponding(new Response('oops', { status: 500 }));

    const error = await recognizer.recognize('segment-0.wav').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RateLimitedError);
  });
});
