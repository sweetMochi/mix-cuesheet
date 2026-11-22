/**
 * 分析任務執行器：下載混音影片的音訊、切出片段、並行辨識，並以一連串事件回報進度與曲目表
 *
 * 音訊來源與辨識器都由外部注入，測試時可以換成假的實作
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AudioSourceError, type AudioSource, type AudioSourceErrorCode, type PreparedAudio } from './audio-source.ts';
import { buildCuesheet, type Cuesheet, type SegmentResult } from './cuesheet.ts';
import { defaultSleep, recognizeSegments, type RecognitionOptions, type Sleep } from './recognition-scheduler.ts';
import type { Recognizer } from './recognizer.ts';
import { planSegments, type SegmentPlanOptions } from './segment-plan.ts';
import { formatTimestamp } from './timestamp.ts';
import type { VideoInfo } from './video-probe.ts';

export type AnalysisPhase = 'downloading' | 'splitting' | 'recognizing';

export type AnalysisErrorCode = AudioSourceErrorCode | 'unexpected';

export type AnalysisEvent =
  /** 進入新的階段 */
  | { type: 'phase'; phase: AnalysisPhase }
  /** 辨識進度：已完成 `completed` 段，共 `total` 段 */
  | { type: 'progress'; completed: number; total: number }
  /** 依目前已完成的辨識結果重新計算的完整曲目表 */
  | { type: 'cuesheet'; cuesheet: Cuesheet }
  /** 分析完成，附上最終曲目表 */
  | { type: 'done'; cuesheet: Cuesheet }
  /** 分析失敗；`message` 是給使用者看的繁體中文訊息 */
  | { type: 'error'; code: AnalysisErrorCode; message: string; detail?: string }
  /** 收到取消信號，任務已停止 */
  | { type: 'cancelled' };

export type AnalysisSettings = SegmentPlanOptions & RecognitionOptions;

export interface AnalysisInput {
  video: Pick<VideoInfo, 'videoId' | 'durationSeconds'>;
  settings: AnalysisSettings;
  audioSource: AudioSource;
  recognizer: Recognizer;
  signal?: AbortSignal;
  /** 限流冷卻的等待方式；預設真的等待，測試時可以換成立即返回 */
  sleep?: Sleep;
  /** 任務暫存資料夾建立在這個資料夾底下；預設為系統的暫存資料夾 */
  tempRoot?: string;
  /** 取得目前時間（毫秒），用來計算各階段耗時；預設為 `Date.now` */
  now?: () => number;
  /** 輸出任務完成時的耗時記錄與辨識統計；預設為 `console.log` */
  log?: (message: string) => void;
  /** 輸出辨識失敗的片段；預設為 `console.warn` */
  warn?: (message: string) => void;
}

/** 暫存資料夾名稱的前綴 */
export const WORK_DIR_PREFIX = 'mix-cuesheet-';

/**
 * 執行一次分析任務，依序產出事件，最後一定是完成、錯誤或已取消事件
 *
 * `signal` 中止時停止送出新的辨識請求、中止進行中的子程序，並送出已取消事件。
 * 不論完成、出錯或取消，任務專屬的暫存資料夾都會在產生器結束前刪除
 */
export async function* runAnalysis(input: AnalysisInput): AsyncGenerator<AnalysisEvent, void, undefined> {
  const { video, settings, audioSource, recognizer, signal } = input;
  const segments = planSegments(video.durationSeconds, settings);
  const now = input.now ?? Date.now;
  const phaseStartedAt: Record<AnalysisPhase, number> = { downloading: 0, splitting: 0, recognizing: 0 };
  let workDir: string | null = null;
  // 取消時子程序或請求會以中止錯誤結束，這時要送出已取消事件，而不是錯誤事件
  const failed = (error: unknown, code: AnalysisErrorCode, message: string): AnalysisEvent =>
    signal?.aborted ? { type: 'cancelled' } : errorEvent(error, code, message);

  try {
    signal?.throwIfAborted();
    workDir = await mkdtemp(path.join(input.tempRoot ?? tmpdir(), WORK_DIR_PREFIX));

    phaseStartedAt.downloading = now();
    yield { type: 'phase', phase: 'downloading' };
    let audio: PreparedAudio;
    try {
      audio = await audioSource.prepare(video.videoId, workDir, signal);
      signal?.throwIfAborted();
    } catch (error) {
      yield failed(error, 'download-failed', '下載音訊失敗');
      return;
    }

    phaseStartedAt.splitting = now();
    yield { type: 'phase', phase: 'splitting' };
    const files: string[] = [];
    try {
      for (const segment of segments) {
        signal?.throwIfAborted();
        files.push(await audio.extractSegment(segment, signal));
      }
    } catch (error) {
      yield failed(error, 'split-failed', '切割音訊失敗');
      return;
    }

    phaseStartedAt.recognizing = now();
    yield { type: 'phase', phase: 'recognizing' };
    yield { type: 'progress', completed: 0, total: segments.length };
    const results: SegmentResult[] = [];
    const stats: RecognitionStats = { requests: 0, rateLimited: 0, failedStartSeconds: [] };
    const cuesheet = () => buildCuesheet({ segments, durationSeconds: video.durationSeconds, results });
    // 結果依完成的先後回來；曲目表依片段起始時間計算，順序不影響快照
    for await (const { index, track, failureReason, requests, rateLimited } of recognizeSegments({
      files,
      recognizer,
      options: settings,
      sleep: input.sleep ?? defaultSleep,
      signal,
    })) {
      const { startSeconds } = segments[index]!;
      results.push({ startSeconds, track });
      stats.requests += requests;
      stats.rateLimited += rateLimited;
      if (failureReason !== null) {
        stats.failedStartSeconds.push(startSeconds);
        (input.warn ?? console.warn)(`片段 ${formatTimestamp(startSeconds)} 辨識失敗，視為無結果：${failureReason}`);
      }
      yield { type: 'progress', completed: results.length, total: segments.length };
      yield { type: 'cuesheet', cuesheet: cuesheet() };
    }

    const finishedAt = now();
    const log = input.log ?? console.log;
    log(
      formatTimingSummary({
        durationSeconds: video.durationSeconds,
        segmentCount: segments.length,
        phaseStartedAt,
        finishedAt,
      }),
    );
    log(formatRecognitionStats(stats, segments.length, finishedAt - phaseStartedAt.recognizing));
    yield { type: 'done', cuesheet: cuesheet() };
  } catch (error) {
    yield failed(error, 'unexpected', '分析時發生未預期的錯誤');
  } finally {
    if (workDir !== null) {
      await removeWorkDir(workDir);
    }
  }
}

/**
 * 任務完成時的耗時記錄，方便手動驗證時記下實際速度，例如
 * `分析完成：影片 25:26、77 段，總耗時 31:12（下載 00:15、切割 00:08、辨識 30:49）`
 *
 * 總耗時從開始下載算到辨識完成；各項耗時都捨去不足 1 秒的部分，加總可能和總耗時差 1～2 秒
 */
function formatTimingSummary(timing: {
  durationSeconds: number;
  segmentCount: number;
  phaseStartedAt: Record<AnalysisPhase, number>;
  finishedAt: number;
}): string {
  const { phaseStartedAt, finishedAt } = timing;
  const elapsed = (fromMs: number, toMs: number) => formatTimestamp((toMs - fromMs) / 1000);
  const phases = [
    `下載 ${elapsed(phaseStartedAt.downloading, phaseStartedAt.splitting)}`,
    `切割 ${elapsed(phaseStartedAt.splitting, phaseStartedAt.recognizing)}`,
    `辨識 ${elapsed(phaseStartedAt.recognizing, finishedAt)}`,
  ];
  return (
    `分析完成：影片 ${formatTimestamp(timing.durationSeconds)}、${timing.segmentCount} 段，` +
    `總耗時 ${elapsed(phaseStartedAt.downloading, finishedAt)}（${phases.join('、')}）`
  );
}

/** 一次分析任務的辨識統計 */
interface RecognitionStats {
  /** 呼叫辨識器的總次數，包含被限流的請求 */
  requests: number;
  /** 被限流的總次數 */
  rateLimited: number;
  /** 辨識失敗的片段起始秒數，依完成的先後排列 */
  failedStartSeconds: number[];
}

/**
 * 任務完成時的辨識統計，用來比較不同限流參數的效果，例如
 * `辨識統計：平均每段 26.2 秒，請求 210 次、被限流 129 次，失敗 2 段（10:00、10:20）`
 */
function formatRecognitionStats(stats: RecognitionStats, segmentCount: number, recognizingMs: number): string {
  const perSegment = segmentCount === 0 ? 0 : recognizingMs / 1000 / segmentCount;
  const failed = stats.failedStartSeconds.toSorted((a, b) => a - b).map((seconds) => formatTimestamp(seconds));
  return (
    `辨識統計：平均每段 ${perSegment.toFixed(1)} 秒，請求 ${stats.requests} 次、被限流 ${stats.rateLimited} 次，` +
    `失敗 ${failed.length} 段${failed.length > 0 ? `（${failed.join('、')}）` : ''}`
  );
}

function errorEvent(error: unknown, fallbackCode: AnalysisErrorCode, fallbackMessage: string): AnalysisEvent {
  if (error instanceof AudioSourceError) {
    return {
      type: 'error',
      code: error.code,
      message: error.message,
      ...(error.detail !== null ? { detail: error.detail } : {}),
    };
  }
  return { type: 'error', code: fallbackCode, message: fallbackMessage, detail: String(error) };
}

async function removeWorkDir(workDir: string): Promise<void> {
  try {
    // Windows 上剛結束的子程序可能還沒釋放檔案，失敗時稍等重試
    await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    console.warn(`無法刪除暫存資料夾 ${workDir}：${String(error)}`);
  }
}
