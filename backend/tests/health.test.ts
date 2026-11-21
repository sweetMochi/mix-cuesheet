import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { unusedJobs } from './fakes.ts';
import { checkTools, type ToolStatus } from '../src/tools.ts';

function appWithTools(...statuses: ToolStatus[]) {
  return createApp({
    checkTools: () => statuses,
    ytDlpVersion: '2026.10.26',
    probeVideo: async () => {
      throw new Error('健康檢查不應該讀取影片');
    },
    jobs: unusedJobs,
    frontendDistDir: null,
  });
}

describe('GET /api/health', () => {
  it('所有工具都可用時回報 ok，並附上 yt-dlp 版本', async () => {
    const app = appWithTools(
      { name: 'yt-dlp', available: true },
      { name: 'FFmpeg', available: true },
    );

    const response = await app.request('/api/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      tools: [
        { name: 'yt-dlp', available: true },
        { name: 'FFmpeg', available: true },
      ],
      ytDlpVersion: '2026.10.26',
    });
  });

  it('指出缺少的是哪一個工具', async () => {
    const app = appWithTools(
      { name: 'yt-dlp', available: true },
      { name: 'FFmpeg', available: false },
    );

    const body = await (await app.request('/api/health')).json();

    expect(body.ok).toBe(false);
    expect(body.tools).toContainEqual({ name: 'FFmpeg', available: false });
  });
});

describe('checkTools', () => {
  it('依執行檔是否存在判斷工具是否可用', () => {
    const existing = new Set(['/tools/yt-dlp']);

    const statuses = checkTools(
      [
        { name: 'yt-dlp', path: '/tools/yt-dlp' },
        { name: 'FFmpeg', path: '/tools/ffmpeg' },
      ],
      (path) => existing.has(path),
    );

    expect(statuses).toEqual([
      { name: 'yt-dlp', available: true },
      { name: 'FFmpeg', available: false },
    ]);
  });

  it('套件沒有提供執行檔路徑時視為不可用', () => {
    const statuses = checkTools([{ name: 'FFmpeg', path: null }], () => true);

    expect(statuses).toEqual([{ name: 'FFmpeg', available: false }]);
  });
});
