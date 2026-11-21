import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAnalysis, type AnalysisEvent } from '../src/analysis-runner.ts';
import { AudioSourceError } from '../src/audio-source.ts';
import { RateLimitedError, type RecognizedTrack } from '../src/recognizer.ts';
import { planSegments } from '../src/segment-plan.ts';
import { fakeAudioSource, fakeRecognizer, track } from './fakes.ts';

const settings = { segmentSeconds: 12, stepSeconds: 20, minSegmentSeconds: 5 };

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'mix-cuesheet-test-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

async function analyze(
  durationSeconds: number,
  resultAt: (startSeconds: number) => RecognizedTrack | null,
  audioSource = fakeAudioSource(),
) {
  const recognizer = fakeRecognizer(resultAt);
  const events: AnalysisEvent[] = [];
  for await (const event of runAnalysis({
    video: { videoId: 'dQw4w9WgXcQ', durationSeconds },
    settings,
    audioSource,
    recognizer,
    tempRoot,
  })) {
    events.push(event);
  }
  return { events, audioSource, recognizer };
}

function last<T extends AnalysisEvent['type']>(events: AnalysisEvent[], type: T) {
  return events.findLast((event): event is Extract<AnalysisEvent, { type: T }> => event.type === type);
}

/** 依片段起始秒數列出曲目：`{ 0: 'A', 20: 'A', 40: null }` 以外的片段一律無結果 */
function tracksAt(map: Record<number, string | null>) {
  return (startSeconds: number) => {
    const id = map[startSeconds];
    return id === undefined || id === null ? null : track(id);
  };
}

function rowsOf(events: AnalysisEvent[]) {
  return last(events, 'done')!.cuesheet.rows.map((row) => ({
    id: row.track.trackId,
    startSeconds: row.startSeconds,
    startText: row.startText,
    hitCount: row.hitCount,
  }));
}

describe('runAnalysis', () => {
  it('依序經過下載、切割、辨識三個階段，最後送出完成事件', async () => {
    const { events } = await analyze(60, () => null);

    expect(events.filter((event) => event.type === 'phase')).toEqual([
      { type: 'phase', phase: 'downloading' },
      { type: 'phase', phase: 'splitting' },
      { type: 'phase', phase: 'recognizing' },
    ]);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('依切段規劃切出片段，最後一段太短時略過', async () => {
    // 0、20、⋯、100；120 秒起只剩 4 秒，略過
    const { audioSource, recognizer } = await analyze(124, () => null);

    expect(audioSource.extracted).toEqual([
      { startSeconds: 0, durationSeconds: 12 },
      { startSeconds: 20, durationSeconds: 12 },
      { startSeconds: 40, durationSeconds: 12 },
      { startSeconds: 60, durationSeconds: 12 },
      { startSeconds: 80, durationSeconds: 12 },
      { startSeconds: 100, durationSeconds: 12 },
    ]);
    expect(recognizer.calls).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it('進度事件的 N 與預估片段數一致，n 從 0 數到 N', async () => {
    const durationSeconds = 3723;
    const expected = planSegments(durationSeconds, settings).length;

    const { events } = await analyze(durationSeconds, () => null);

    const progress = events.filter((event) => event.type === 'progress');
    expect(progress.every((event) => event.total === expected)).toBe(true);
    expect(progress.map((event) => event.completed)).toEqual(
      Array.from({ length: expected + 1 }, (_, index) => index),
    );
  });

  it('每完成一段就送出重新計算的曲目表快照', async () => {
    const { events } = await analyze(60, tracksAt({ 0: 'A', 20: 'A', 40: 'B' }));

    const snapshots = events
      .filter((event) => event.type === 'cuesheet')
      .map((event) => event.cuesheet.rows.map((row) => `${row.track.trackId}×${row.hitCount}`));
    expect(snapshots).toEqual([['A×1'], ['A×2'], ['A×2', 'B×1']]);
  });

  it('連續命中同一首時合併成一列，開始時間取第一次命中的片段起始時間', async () => {
    const { events } = await analyze(
      140,
      tracksAt({ 0: null, 20: 'A', 40: 'A', 60: 'A', 80: 'B', 100: 'B', 120: 'C' }),
    );

    expect(rowsOf(events)).toEqual([
      { id: 'A', startSeconds: 20, startText: '00:20', hitCount: 3 },
      { id: 'B', startSeconds: 80, startText: '01:20', hitCount: 2 },
      { id: 'C', startSeconds: 120, startText: '02:00', hitCount: 1 },
    ]);
  });

  it('無結果的片段不會打斷連續命中', async () => {
    const { events } = await analyze(80, tracksAt({ 0: 'A', 20: null, 40: 'A', 60: 'B' }));

    expect(rowsOf(events).map((row) => [row.id, row.hitCount])).toEqual([
      ['A', 2],
      ['B', 1],
    ]);
  });

  it('1 小時以上的開始時間格式化為 H:MM:SS', async () => {
    const { events } = await analyze(3640, (start) => track(start < 3600 ? 'A' : 'B'));

    expect(rowsOf(events).map((row) => row.startText)).toEqual(['00:00', '1:00:00']);
  });

  it('辨識器限流或出錯時，該片段視為無結果，任務繼續完成', async () => {
    const { events } = await analyze(60, (start) => {
      if (start === 0) throw new RateLimitedError();
      if (start === 20) throw new Error('network down');
      return track('A');
    });

    expect(rowsOf(events)).toEqual([{ id: 'A', startSeconds: 40, startText: '00:40', hitCount: 1 }]);
    expect(last(events, 'progress')).toEqual({ type: 'progress', completed: 3, total: 3 });
  });

  it('下載失敗時送出錯誤事件，不切割也不辨識', async () => {
    const audioSource = fakeAudioSource({
      prepareError: new AudioSourceError('download-failed', '下載音訊失敗：這支影片是私人影片'),
    });

    const { events, recognizer } = await analyze(60, () => track('A'), audioSource);

    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'download-failed',
      message: '下載音訊失敗：這支影片是私人影片',
    });
    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(audioSource.extracted).toEqual([]);
    expect(recognizer.calls).toEqual([]);
  });

  it('對應不到的下載錯誤顯示通用訊息並附上原始錯誤', async () => {
    const audioSource = fakeAudioSource({ prepareError: new Error('socket hang up') });

    const { events } = await analyze(60, () => null, audioSource);

    expect(events.at(-1)).toMatchObject({
      type: 'error',
      code: 'download-failed',
      message: expect.stringContaining('下載音訊失敗'),
      detail: expect.stringContaining('socket hang up'),
    });
  });

  it('切割失敗時送出錯誤事件', async () => {
    const audioSource = fakeAudioSource({
      extractError: new AudioSourceError('split-failed', '切割音訊失敗', 'Invalid data found'),
    });

    const { events, recognizer } = await analyze(60, () => null, audioSource);

    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'split-failed',
      message: '切割音訊失敗',
      detail: 'Invalid data found',
    });
    expect(recognizer.calls).toEqual([]);
  });

  it('完成後刪除任務暫存資料夾', async () => {
    const { audioSource } = await analyze(60, () => track('A'));

    expect(audioSource.workDirs).toHaveLength(1);
    expect(existsSync(audioSource.workDirs[0]!)).toBe(false);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it('下載失敗後刪除任務暫存資料夾', async () => {
    const audioSource = fakeAudioSource({ prepareError: new Error('boom') });

    await analyze(60, () => null, audioSource);

    expect(audioSource.workDirs).toHaveLength(1);
    expect(existsSync(audioSource.workDirs[0]!)).toBe(false);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it('切割失敗後刪除任務暫存資料夾', async () => {
    const audioSource = fakeAudioSource({ extractError: new Error('boom') });

    await analyze(60, () => null, audioSource);

    expect(await readdir(tempRoot)).toEqual([]);
  });
});
