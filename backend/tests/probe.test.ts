import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import { VideoAccessError } from '../src/video-access.ts';
import type { ProbeVideo } from '../src/video-probe.ts';

const ID = 'dQw4w9WgXcQ';

function appWithProbe(probeVideo: ProbeVideo) {
  return createApp({
    checkTools: () => [],
    ytDlpVersion: null,
    probeVideo,
    frontendDistDir: null,
  });
}

function probeFound(title: string, durationSeconds: number): ProbeVideo {
  return async (videoId) => ({ videoId, title, durationSeconds });
}

function postProbe(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request('/api/videos/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/videos/probe', () => {
  it('回傳影片 ID、標題、長度與預估片段數', async () => {
    const app = appWithProbe(probeFound('Boiler Room Mix', 3723));

    const response = await postProbe(app, { url: `https://youtu.be/${ID}` });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      videoId: ID,
      title: 'Boiler Room Mix',
      durationSeconds: 3723,
      durationText: '1:02:03',
      // 0、20、⋯、3720；最後一段只剩 3 秒，略過
      segmentCount: 186,
    });
  });

  it('只把影片 ID 交給 yt-dlp，不帶播放清單參數', async () => {
    const probeVideo = vi.fn(probeFound('Mix', 600));
    const app = appWithProbe(probeVideo);

    await postProbe(app, { url: `https://www.youtube.com/watch?v=${ID}&list=PL123456789` });

    expect(probeVideo).toHaveBeenCalledWith(ID, expect.anything());
  });

  it('網址不合法時回傳錯誤原因，且不呼叫 yt-dlp', async () => {
    const probeVideo = vi.fn(probeFound('Mix', 600));
    const app = appWithProbe(probeVideo);

    const response = await postProbe(app, { url: 'https://www.youtube.com/playlist?list=PL123' });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('playlist-only');
    expect(body.error.message).toContain('播放清單');
    expect(probeVideo).not.toHaveBeenCalled();
  });

  it('請求缺少 url 欄位時回傳 400', async () => {
    const app = appWithProbe(probeFound('Mix', 600));

    const response = await postProbe(app, { link: ID });

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('bad-request');
  });

  it('影片無法存取時回傳對應的原因，不附原始錯誤', async () => {
    const app = appWithProbe(async () => {
      throw new VideoAccessError('members-only', 'ERROR: Join this channel');
    });

    const response = await postProbe(app, { url: `https://youtu.be/${ID}` });

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe('members-only');
    expect(body.error.message).toContain('會員');
    expect(body.error.detail).toBeUndefined();
  });

  it('對應不到的錯誤顯示通用訊息並附上原始錯誤', async () => {
    const app = appWithProbe(async () => {
      throw new VideoAccessError('unknown', 'ERROR: something new');
    });

    const response = await postProbe(app, { url: `https://youtu.be/${ID}` });

    expect(response.status).toBe(502);
    expect((await response.json()).error).toMatchObject({
      code: 'unknown',
      detail: 'ERROR: something new',
    });
  });

  it('影片超過 3 小時時回傳超過上限的錯誤，並附上影片長度', async () => {
    const app = appWithProbe(probeFound('Marathon Set', 3 * 3600 + 1));

    const response = await postProbe(app, { url: `https://youtu.be/${ID}` });

    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatchObject({
      code: 'too-long',
      durationSeconds: 10801,
      durationText: '3:00:01',
      message: expect.stringContaining('3:00:01'),
    });
  });

  it('影片剛好 3 小時時可以分析', async () => {
    const app = appWithProbe(probeFound('Three Hours', 3 * 3600));

    const response = await postProbe(app, { url: `https://youtu.be/${ID}` });

    expect(response.status).toBe(200);
    expect((await response.json()).segmentCount).toBe(540);
  });
});
