import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAnalysis, type AnalysisEvent, type AnalysisPhase, type AnalysisSettings } from '../src/analysis-runner.ts';
import type { Cuesheet } from '../src/cuesheet.ts';
import { AudioSourceError } from '../src/audio-source.ts';
import type { Sleep } from '../src/recognition-scheduler.ts';
import { RateLimitedError } from '../src/recognizer.ts';
import { planSegments } from '../src/segment-plan.ts';
import {
  fakeAudioSource,
  fakeRecognizer,
  instantSleep,
  manualSleep,
  sequence,
  track,
  type FakeAudioSource,
} from './fakes.ts';

const settings: AnalysisSettings = {
  segmentSeconds: 12,
  stepSeconds: 20,
  minSegmentSeconds: 5,
  concurrency: 2,
  retryAttempts: 3,
  backoffBaseMs: 5000,
  backoffMaxMs: 30000,
};

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'mix-cuesheet-test-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

interface AnalyzeOptions {
  audioSource?: FakeAudioSource;
  settings?: Partial<AnalysisSettings>;
  /** 預設為立即返回的等待 */
  sleep?: Sleep;
  /** 預設為 `Date.now` */
  now?: () => number;
  /** 預設不輸出 */
  log?: (message: string) => void;
  /** 每收到一個事件就呼叫，用來在事件之間推進假時鐘 */
  onEvent?: (event: AnalysisEvent) => void;
}

async function analyze(
  durationSeconds: number,
  resultAt: Parameters<typeof fakeRecognizer>[0],
  options: AnalyzeOptions = {},
) {
  const audioSource = options.audioSource ?? fakeAudioSource();
  const recognizer = fakeRecognizer(resultAt);
  const events: AnalysisEvent[] = [];
  for await (const event of runAnalysis({
    video: { videoId: 'dQw4w9WgXcQ', durationSeconds },
    settings: { ...settings, ...options.settings },
    audioSource,
    recognizer,
    tempRoot,
    sleep: options.sleep ?? instantSleep().sleep,
    now: options.now,
    log: options.log ?? (() => {}),
  })) {
    events.push(event);
    options.onEvent?.(event);
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

  describe('並行辨識', () => {
    it('同時進行的辨識請求數不超過設定的並行度', async () => {
      const { recognizer, events } = await analyze(
        200,
        async () => {
          await wait(1);
          return null;
        },
        { settings: { concurrency: 3 } },
      );

      expect(recognizer.maxInFlight).toBe(3);
      expect(recognizer.calls.toSorted((a, b) => a - b)).toEqual([0, 20, 40, 60, 80, 100, 120, 140, 160, 180]);
      expect(last(events, 'progress')).toEqual({ type: 'progress', completed: 10, total: 10 });
    });

    it('辨識結果亂序完成時，快照仍依開始時間排序，待處理的片段不算無結果', async () => {
      // 片段 0 最後才完成，20、40、60 先完成
      const { events } = await analyze(80, async (start) => {
        if (start === 0) {
          await wait(1);
          return track('A');
        }
        return start === 60 ? track('B') : null;
      });

      expect(snapshots(events)).toEqual([
        // 片段 20 無結果，0 待處理
        [],
        // 片段 20、40 無結果；0 待處理，不會和它們連成 00:00 起的區間
        ['00:20–01:00 未辨識'],
        ['00:20–01:00 未辨識', '01:00 B×1（僅命中 1 次）'],
        ['00:00 A×1（僅命中 1 次）', '00:20–01:00 未辨識', '01:00 B×1（僅命中 1 次）'],
      ]);
      expect(events.filter((event) => event.type === 'progress').map((event) => event.completed)).toEqual([
        0, 1, 2, 3, 4,
      ]);
    });
  });

  describe('限流重試', () => {
    it('限流後以指數退避等待再重試，重試成功時採用該結果', async () => {
      const at20 = sequence(new RateLimitedError(), new RateLimitedError(), track('A'));
      const { sleep, delays } = instantSleep();

      const { events, recognizer } = await analyze(60, (start) => (start === 20 ? at20() : track('A')), { sleep });

      expect(finalRows(events)).toEqual(['00:00 A×3']);
      expect(recognizer.calls.filter((start) => start === 20)).toHaveLength(3);
      expect(delays).toEqual([5000, 10000]);
    });

    it('重試用完後該片段視為無結果，任務照常完成', async () => {
      const { sleep, delays } = instantSleep();

      const { events, recognizer } = await analyze(
        80,
        (start) => {
          if (start === 20) throw new RateLimitedError();
          return start === 0 ? track('A') : start === 60 ? track('B') : null;
        },
        { sleep, settings: { retryAttempts: 4 } },
      );

      // 片段 20 重試用完、40 無結果，連成一段「未辨識」
      expect(finalRows(events)).toEqual([
        '00:00 A×1（僅命中 1 次）',
        '00:20–01:00 未辨識',
        '01:00 B×1（僅命中 1 次）',
      ]);
      expect(recognizer.calls.filter((start) => start === 20)).toHaveLength(5);
      // 每次加倍，超過上限時取上限
      expect(delays).toEqual([5000, 10000, 20000, 30000]);
      expect(last(events, 'progress')).toEqual({ type: 'progress', completed: 4, total: 4 });
      expect(events.at(-1)?.type).toBe('done');
    });

    it('其他辨識錯誤不重試，該片段視為無結果', async () => {
      const { sleep, delays } = instantSleep();

      const { events, recognizer } = await analyze(
        80,
        (start) => {
          if (start === 20) throw new Error('network down');
          return start === 40 ? null : track('A');
        },
        { sleep },
      );

      expect(finalRows(events)).toEqual(['00:00 A×2', '00:20–01:00 未辨識']);
      expect(recognizer.calls.filter((start) => start === 20)).toHaveLength(1);
      expect(delays).toEqual([]);
    });

    it('任一片段被限流時，所有請求都等冷卻結束才送出', async () => {
      const calls: number[] = [];
      const at0 = sequence(new RateLimitedError(), track('A'));
      const { sleep, delays, release } = manualSleep();

      const running = analyze(
        80,
        async (start) => {
          calls.push(start);
          if (start === 0) return at0();
          if (start === 20) await wait(1);
          return track('A');
        },
        { sleep },
      );

      // 片段 0 被限流後進入冷卻；片段 20 在冷卻期間完成，但下一個片段 40 要等冷卻結束才送出
      await vi.waitFor(() => expect(delays).toHaveLength(1));
      await wait(20);
      expect(calls).toEqual([0, 20]);
      expect(delays).toEqual([5000]);

      release();
      const { events } = await running;

      expect(calls.toSorted((a, b) => a - b)).toEqual([0, 0, 20, 40, 60]);
      expect(finalRows(events)).toEqual(['00:00 A×4']);
    });
  });

  describe('耗時記錄', () => {
    /** 收到各階段事件時把假時鐘推進該階段的耗時（毫秒），模擬各階段實際花的時間 */
    function timedRun(
      durationSeconds: number,
      phaseMs: Partial<Record<AnalysisPhase, number>>,
      options: AnalyzeOptions = {},
    ) {
      let time = 1_000_000;
      const messages: string[] = [];
      const run = analyze(durationSeconds, () => null, {
        ...options,
        now: () => time,
        log: (message) => messages.push(message),
        onEvent: (event) => {
          if (event.type === 'phase') {
            time += phaseMs[event.phase] ?? 0;
          }
        },
      });
      return { run, messages };
    }

    it('完成時輸出一行影片長度、片段數，以及總耗時與各階段耗時', async () => {
      const { run, messages } = timedRun(60, { downloading: 15_400, splitting: 8_000, recognizing: 1_849_000 });
      await run;

      expect(messages).toEqual(['分析完成：影片 01:00、3 段，總耗時 31:12（下載 00:15、切割 00:08、辨識 30:49）']);
    });

    it('耗時 1 小時以上時以 H:MM:SS 顯示', async () => {
      const { run, messages } = timedRun(3723, { downloading: 30_000, splitting: 60_000, recognizing: 2 * 3600_000 });
      await run;

      expect(messages).toEqual([
        `分析完成：影片 1:02:03、${planSegments(3723, settings).length} 段，總耗時 2:01:30（下載 00:30、切割 01:00、辨識 2:00:00）`,
      ]);
    });

    it('分析失敗時不輸出耗時記錄', async () => {
      const audioSource = fakeAudioSource({ prepareError: new AudioSourceError('download-failed', '下載音訊失敗') });
      const { run, messages } = timedRun(60, { downloading: 15_000 }, { audioSource });
      const { events } = await run;

      expect(events.at(-1)?.type).toBe('error');
      expect(messages).toEqual([]);
    });
  });

  it('下載失敗時送出錯誤事件，不切割也不辨識', async () => {
    const audioSource = fakeAudioSource({
      prepareError: new AudioSourceError('download-failed', '下載音訊失敗：這支影片是私人影片'),
    });

    const { events, recognizer } = await analyze(60, () => track('A'), { audioSource });

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

    const { events } = await analyze(60, () => null, { audioSource });

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

    const { events, recognizer } = await analyze(60, () => null, { audioSource });

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

    await analyze(60, () => null, { audioSource });

    expect(audioSource.workDirs).toHaveLength(1);
    expect(existsSync(audioSource.workDirs[0]!)).toBe(false);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it('切割失敗後刪除任務暫存資料夾', async () => {
    const audioSource = fakeAudioSource({ extractError: new Error('boom') });

    await analyze(60, () => null, { audioSource });

    expect(await readdir(tempRoot)).toEqual([]);
  });
});
