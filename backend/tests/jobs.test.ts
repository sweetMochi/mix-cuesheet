import { describe, expect, it, vi } from 'vitest';
import { createAnalysisJobs, type RunAnalysis } from '../src/analysis-jobs.ts';
import type { AnalysisEvent } from '../src/analysis-runner.ts';
import { createApp } from '../src/app.ts';
import type { ProbeVideo } from '../src/video-probe.ts';
import { track, untilAborted } from './fakes.ts';

const ID = 'dQw4w9WgXcQ';

const cuesheet = {
  rows: [{ kind: 'track' as const, startSeconds: 0, startText: '00:00', track: track('A'), hitCount: 1, singleHit: true }],
};

const happyEvents: AnalysisEvent[] = [
  { type: 'phase', phase: 'downloading' },
  { type: 'phase', phase: 'splitting' },
  { type: 'phase', phase: 'recognizing' },
  { type: 'progress', completed: 0, total: 1 },
  { type: 'progress', completed: 1, total: 1 },
  { type: 'cuesheet', cuesheet },
  { type: 'done', cuesheet },
];

function runEmitting(events: AnalysisEvent[]): RunAnalysis {
  return async function* () {
    yield* events;
  };
}

/** 進入下載階段後一直執行，直到收到取消信號 */
const runUntilCancelled: RunAnalysis = async function* (_video, signal) {
  yield { type: 'phase', phase: 'downloading' };
  await untilAborted(signal).catch(() => {});
  yield { type: 'cancelled' };
};

function appWith(run: RunAnalysis, probeVideo: ProbeVideo = async (videoId) => ({ videoId, title: 'Mix', durationSeconds: 20 })) {
  return createApp({
    checkTools: () => [],
    ytDlpVersion: null,
    probeVideo,
    jobs: createAnalysisJobs(run),
    frontendDistDir: null,
  });
}

function createJob(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 讀完整個 SSE 串流，解析成事件名稱與資料 */
async function readSse(response: Response) {
  const text = await response.text();
  return text
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const fields = Object.fromEntries(
        block.split('\n').map((line) => {
          const separator = line.indexOf(':');
          return [line.slice(0, separator), line.slice(separator + 1).trimStart()];
        }),
      );
      return { event: fields.event, data: JSON.parse(fields.data) as AnalysisEvent };
    });
}

describe('POST /api/jobs', () => {
  it('以影片 ID 建立任務並回傳任務 ID', async () => {
    const run = vi.fn(runEmitting(happyEvents));
    const app = appWith(run);

    const response = await createJob(app, { videoId: ID });

    expect(response.status).toBe(201);
    expect((await response.json()).jobId).toEqual(expect.any(String));
    expect(run).toHaveBeenCalledWith({ videoId: ID, title: 'Mix', durationSeconds: 20 }, expect.any(AbortSignal));
  });

  it('已經有任務在執行時回傳 409，且不讀取影片資訊也不建立任務', async () => {
    const run = vi.fn(runUntilCancelled);
    const probeVideo = vi.fn<ProbeVideo>(async (videoId) => ({ videoId, title: 'Mix', durationSeconds: 20 }));
    const app = appWith(run, probeVideo);
    const { jobId } = await (await createJob(app, { videoId: ID })).json();

    const response = await createJob(app, { videoId: ID });

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('job-running');
    expect(run).toHaveBeenCalledTimes(1);
    expect(probeVideo).toHaveBeenCalledTimes(1);
    await app.request(`/api/jobs/${jobId}`, { method: 'DELETE' });
  });

  it('讀取影片資訊期間有別的任務開始時，仍回傳 409', async () => {
    const run = vi.fn(runUntilCancelled);
    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => (releaseProbe = resolve));
    const app = appWith(run, async (videoId) => {
      await probeGate;
      return { videoId, title: 'Mix', durationSeconds: 20 };
    });

    const first = createJob(app, { videoId: ID });
    const second = createJob(app, { videoId: ID });
    releaseProbe();
    const statuses = [(await first).status, (await second).status].toSorted();

    expect(statuses).toEqual([201, 409]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('上一個任務結束後可以建立新的任務', async () => {
    const run = vi.fn(runEmitting(happyEvents));
    const app = appWith(run);
    const { jobId } = await (await createJob(app, { videoId: ID })).json();
    await readSse(await app.request(`/api/jobs/${jobId}/events`));

    await vi.waitFor(async () => expect((await createJob(app, { videoId: ID })).status).toBe(201));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('影片 ID 格式不對時回傳 400，且不建立任務', async () => {
    const run = vi.fn(runEmitting(happyEvents));
    const app = appWith(run);

    const response = await createJob(app, { videoId: 'not-an-id' });

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('bad-request');
    expect(run).not.toHaveBeenCalled();
  });

  it('影片超過長度上限時回傳錯誤，且不建立任務', async () => {
    const run = vi.fn(runEmitting(happyEvents));
    const app = appWith(run, async (videoId) => ({ videoId, title: 'Long', durationSeconds: 3 * 3600 + 1 }));

    const response = await createJob(app, { videoId: ID });

    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe('too-long');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('GET /api/jobs/:jobId/events', () => {
  it('以 SSE 推送任務的事件，直到完成事件為止', async () => {
    const app = appWith(runEmitting(happyEvents));
    const { jobId } = await (await createJob(app, { videoId: ID })).json();

    const response = await app.request(`/api/jobs/${jobId}/events`);

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const events = await readSse(response);
    expect(events.map((event) => event.event)).toEqual(events.map((event) => event.data.type));
    expect(events.at(-1)?.data).toEqual({ type: 'done', cuesheet });
  });

  it('即時推送訂閱之後才發生的事件', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const app = appWith(async function* () {
      yield { type: 'phase', phase: 'downloading' };
      await gate;
      yield { type: 'error', code: 'download-failed', message: '下載音訊失敗' };
    });
    const { jobId } = await (await createJob(app, { videoId: ID })).json();

    const response = await app.request(`/api/jobs/${jobId}/events`);
    release();

    expect((await readSse(response)).map((event) => event.data)).toEqual([
      { type: 'phase', phase: 'downloading' },
      { type: 'error', code: 'download-failed', message: '下載音訊失敗' },
    ]);
  });

  it('任務結束後才訂閱時，重播最後的狀態', async () => {
    const app = appWith(runEmitting(happyEvents));
    const { jobId } = await (await createJob(app, { videoId: ID })).json();
    // 讓任務先跑完
    await readSse(await app.request(`/api/jobs/${jobId}/events`));

    const replay = await readSse(await app.request(`/api/jobs/${jobId}/events`));

    expect(replay.map((event) => event.data)).toEqual([
      { type: 'phase', phase: 'recognizing' },
      { type: 'progress', completed: 1, total: 1 },
      { type: 'cuesheet', cuesheet },
      { type: 'done', cuesheet },
    ]);
  });

  it('任務執行器意外丟出錯誤時送出錯誤事件', async () => {
    const app = appWith(async function* () {
      yield { type: 'phase', phase: 'downloading' };
      throw new Error('kaboom');
    });
    const { jobId } = await (await createJob(app, { videoId: ID })).json();

    const events = await readSse(await app.request(`/api/jobs/${jobId}/events`));

    expect(events.at(-1)?.data).toMatchObject({ type: 'error', code: 'unexpected', detail: 'Error: kaboom' });
  });

  it('找不到任務時回傳 404', async () => {
    const app = appWith(runEmitting(happyEvents));

    const response = await app.request('/api/jobs/unknown/events');

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('not-found');
  });
});

describe('DELETE /api/jobs/:jobId', () => {
  it('對任務送出取消信號，事件串流以已取消事件結束', async () => {
    const app = appWith(runUntilCancelled);
    const { jobId } = await (await createJob(app, { videoId: ID })).json();
    const stream = app.request(`/api/jobs/${jobId}/events`);

    const response = await app.request(`/api/jobs/${jobId}`, { method: 'DELETE' });

    expect(response.status).toBe(202);
    expect((await readSse(await stream)).map((event) => event.data)).toEqual([
      { type: 'phase', phase: 'downloading' },
      { type: 'cancelled' },
    ]);
  });

  it('取消後才訂閱時重播已取消事件', async () => {
    const app = appWith(runUntilCancelled);
    const { jobId } = await (await createJob(app, { videoId: ID })).json();
    await app.request(`/api/jobs/${jobId}`, { method: 'DELETE' });

    const replay = await readSse(await app.request(`/api/jobs/${jobId}/events`));

    expect(replay.map((event) => event.data)).toEqual([
      { type: 'phase', phase: 'downloading' },
      { type: 'cancelled' },
    ]);
  });

  it('取消後可以建立新的任務', async () => {
    const run = vi.fn(runUntilCancelled);
    const app = appWith(run);
    const { jobId } = await (await createJob(app, { videoId: ID })).json();

    await app.request(`/api/jobs/${jobId}`, { method: 'DELETE' });

    await vi.waitFor(async () => expect((await createJob(app, { videoId: ID })).status).toBe(201));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('任務執行器沒有送出已取消事件就結束時，仍以已取消事件結束', async () => {
    const app = appWith(async function* (_video, signal) {
      yield { type: 'phase', phase: 'downloading' };
      await untilAborted(signal);
    });
    const { jobId } = await (await createJob(app, { videoId: ID })).json();

    await app.request(`/api/jobs/${jobId}`, { method: 'DELETE' });

    const events = await readSse(await app.request(`/api/jobs/${jobId}/events`));
    expect(events.at(-1)?.data).toEqual({ type: 'cancelled' });
  });

  it('任務已經完成時不改變結果', async () => {
    const app = appWith(runEmitting(happyEvents));
    const { jobId } = await (await createJob(app, { videoId: ID })).json();
    await readSse(await app.request(`/api/jobs/${jobId}/events`));

    const response = await app.request(`/api/jobs/${jobId}`, { method: 'DELETE' });

    expect(response.status).toBe(202);
    const replay = await readSse(await app.request(`/api/jobs/${jobId}/events`));
    expect(replay.at(-1)?.data).toEqual({ type: 'done', cuesheet });
  });

  it('找不到任務時回傳 404', async () => {
    const app = appWith(runEmitting(happyEvents));

    const response = await app.request('/api/jobs/unknown', { method: 'DELETE' });

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('not-found');
  });
});
