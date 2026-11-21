import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAnalysis, type AnalysisEvent } from '../src/analysis-runner.ts';
import type { Cuesheet } from '../src/cuesheet.ts';
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

/**
 * 把曲目表寫成容易比對的字串：
 * 曲目列為 `開始時間 識別碼×命中次數`，「僅命中 1 次」加上 `（僅命中 1 次）`；「未辨識」列為 `開始–結束 未辨識`
 */
function describeRows(cuesheet: Cuesheet) {
  return cuesheet.rows.map((row) =>
    row.kind === 'track'
      ? `${row.startText} ${row.track.trackId}×${row.hitCount}${row.singleHit ? '（僅命中 1 次）' : ''}`
      : `${row.startText}–${row.endText} 未辨識`,
  );
}

function finalRows(events: AnalysisEvent[]) {
  return describeRows(last(events, 'done')!.cuesheet);
}

function snapshots(events: AnalysisEvent[]) {
  return events.filter((event) => event.type === 'cuesheet').map((event) => describeRows(event.cuesheet));
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

    expect(snapshots(events)).toEqual([
      ['00:00 A×1（僅命中 1 次）'],
      ['00:00 A×2'],
      ['00:00 A×2', '00:40 B×1（僅命中 1 次）'],
    ]);
  });

  describe('合併規則', () => {
    it('連續命中同一首時合併成一列，開始時間取第一次命中的片段起始時間', async () => {
      const { events } = await analyze(
        140,
        tracksAt({ 0: 'A', 20: 'A', 40: 'A', 60: 'B', 80: 'B', 100: 'C', 120: 'C' }),
      );

      expect(finalRows(events)).toEqual(['00:00 A×3', '01:00 B×2', '01:40 C×2']);
      expect(last(events, 'done')!.cuesheet.rows[1]).toMatchObject({ kind: 'track', startSeconds: 60 });
    });

    it('以曲目識別碼判斷是否為同一首，不看演出者與曲名', async () => {
      const { events } = await analyze(60, (start) => {
        if (start === 0) return track('A');
        if (start === 20) return { ...track('A'), title: 'Title A (Radio Edit)' };
        return { ...track('B'), artist: 'Artist A', title: 'Title A' };
      });

      expect(finalRows(events)).toEqual(['00:00 A×2', '00:40 B×1（僅命中 1 次）']);
    });

    it('同一首被其他曲目隔開後再出現時仍只有一列，開始時間取最早一次命中', async () => {
      const { events } = await analyze(
        120,
        tracksAt({ 0: 'A', 20: 'A', 40: 'B', 60: 'A', 80: 'B', 100: 'B' }),
      );

      expect(finalRows(events)).toEqual(['00:00 A×3', '00:40 B×3']);
    });

    it('同一首被無結果片段隔開後再出現時仍只有一列', async () => {
      const { events } = await analyze(
        140,
        tracksAt({ 0: 'A', 20: null, 40: 'A', 60: null, 80: null, 100: 'A', 120: 'B' }),
      );

      expect(finalRows(events)).toEqual(['00:00 A×3', '01:00–01:40 未辨識', '02:00 B×1（僅命中 1 次）']);
    });

    it('「僅命中 1 次」以整支影片的總命中次數判斷', async () => {
      const { events } = await analyze(80, tracksAt({ 0: 'A', 20: 'B', 40: 'C', 60: 'A' }));

      expect(snapshots(events)[0]).toEqual(['00:00 A×1（僅命中 1 次）']);
      expect(finalRows(events)).toEqual(['00:00 A×2', '00:20 B×1（僅命中 1 次）', '00:40 C×1（僅命中 1 次）']);
    });

    it('單一個無結果片段不產生「未辨識」列', async () => {
      const { events } = await analyze(100, tracksAt({ 0: null, 20: 'A', 40: null, 60: 'B', 80: null }));

      expect(finalRows(events)).toEqual(['00:20 A×1（僅命中 1 次）', '01:00 B×1（僅命中 1 次）']);
    });

    it('連續 2 個以上的無結果片段合併成一列「未辨識」，到下一個片段的起始時間為止', async () => {
      const { events } = await analyze(120, tracksAt({ 0: 'A', 20: null, 40: null, 60: null, 80: 'B', 100: 'B' }));

      expect(finalRows(events)).toEqual(['00:00 A×1（僅命中 1 次）', '00:20–01:20 未辨識', '01:20 B×2']);
      expect(last(events, 'done')!.cuesheet.rows[1]).toEqual({
        kind: 'unrecognized',
        startSeconds: 20,
        startText: '00:20',
        endSeconds: 80,
        endText: '01:20',
      });
    });

    it('影片結尾的「未辨識」區間到影片結尾為止', async () => {
      // 片段 0、20、⋯、100；120 秒起只剩 4 秒，略過
      const { events } = await analyze(124, tracksAt({ 0: 'A', 20: 'A', 40: 'B', 60: 'B' }));

      expect(finalRows(events)).toEqual(['00:00 A×2', '00:40 B×2', '01:20–02:04 未辨識']);
    });

    it('整支影片都沒有辨識到曲目時只有一列「未辨識」', async () => {
      const { events } = await analyze(60, () => null);

      expect(finalRows(events)).toEqual(['00:00–01:00 未辨識']);
    });

    it('曲目列與「未辨識」列一起依開始時間排序', async () => {
      const { events } = await analyze(
        160,
        tracksAt({ 0: null, 20: null, 40: 'A', 60: 'B', 80: null, 100: null, 120: 'A', 140: 'C' }),
      );

      expect(finalRows(events)).toEqual([
        '00:00–00:40 未辨識',
        '00:40 A×2',
        '01:00 B×1（僅命中 1 次）',
        '01:20–02:00 未辨識',
        '02:20 C×1（僅命中 1 次）',
      ]);
    });

    it('尚未完成辨識的片段不會被當成無結果，也會中斷連續無結果片段', async () => {
      const { events } = await analyze(100, tracksAt({ 0: 'A' }));

      expect(snapshots(events)).toEqual([
        ['00:00 A×1（僅命中 1 次）'],
        // 片段 20 無結果、40 以後待處理：單一個無結果片段，不算「未辨識」
        ['00:00 A×1（僅命中 1 次）'],
        // 片段 20、40 無結果，60 待處理：區間在待處理的片段前結束
        ['00:00 A×1（僅命中 1 次）', '00:20–01:00 未辨識'],
        ['00:00 A×1（僅命中 1 次）', '00:20–01:20 未辨識'],
        ['00:00 A×1（僅命中 1 次）', '00:20–01:40 未辨識'],
      ]);
    });
  });

  it('1 小時以上的開始時間格式化為 H:MM:SS', async () => {
    const { events } = await analyze(3640, (start) => track(start < 3600 ? 'A' : 'B'));

    expect(last(events, 'done')!.cuesheet.rows.map((row) => row.startText)).toEqual(['00:00', '1:00:00']);
  });

  it('辨識器限流或出錯時，該片段視為無結果，任務繼續完成', async () => {
    const { events } = await analyze(80, (start) => {
      if (start === 0) throw new RateLimitedError();
      if (start === 20) throw new Error('network down');
      return track('A');
    });

    expect(finalRows(events)).toEqual(['00:00–00:40 未辨識', '00:40 A×2']);
    expect(last(events, 'progress')).toEqual({ type: 'progress', completed: 4, total: 4 });
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
