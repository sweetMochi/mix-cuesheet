/**
 * 分析任務執行器：下載混音影片的音訊、切出片段、逐段辨識，並以一連串事件回報進度與曲目表
 *
 * 音訊來源與辨識器都由外部注入，測試時可以換成假的實作
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AudioSourceError, type AudioSource, type AudioSourceErrorCode, type PreparedAudio } from './audio-source.ts';
import { buildCuesheet, type Cuesheet, type SegmentResult } from './cuesheet.ts';
import type { Recognizer } from './recognizer.ts';
import { planSegments, type SegmentPlanOptions } from './segment-plan.ts';
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
  | { type: 'error'; code: AnalysisErrorCode; message: string; detail?: string };

export type AnalysisSettings = SegmentPlanOptions;

export interface AnalysisInput {
  video: Pick<VideoInfo, 'videoId' | 'durationSeconds'>;
  settings: AnalysisSettings;
  audioSource: AudioSource;
  recognizer: Recognizer;
  signal?: AbortSignal;
  /** 任務暫存資料夾建立在這個資料夾底下；預設為系統的暫存資料夾 */
  tempRoot?: string;
}

/** 暫存資料夾名稱的前綴 */
export const WORK_DIR_PREFIX = 'mix-cuesheet-';

/**
 * 執行一次分析任務，依序產出事件，最後一定是完成或錯誤事件
 *
 * 不論完成或出錯，任務專屬的暫存資料夾都會在產生器結束前刪除
 */
export async function* runAnalysis(input: AnalysisInput): AsyncGenerator<AnalysisEvent, void, undefined> {
  const { video, settings, audioSource, recognizer, signal } = input;
  const segments = planSegments(video.durationSeconds, settings);
  let workDir: string | null = null;

  try {
    workDir = await mkdtemp(path.join(input.tempRoot ?? tmpdir(), WORK_DIR_PREFIX));

    yield { type: 'phase', phase: 'downloading' };
    let audio: PreparedAudio;
    try {
      audio = await audioSource.prepare(video.videoId, workDir, signal);
    } catch (error) {
      yield errorEvent(error, 'download-failed', '下載音訊失敗');
      return;
    }

    yield { type: 'phase', phase: 'splitting' };
    const files: string[] = [];
    try {
      for (const segment of segments) {
        files.push(await audio.extractSegment(segment, signal));
      }
    } catch (error) {
      yield errorEvent(error, 'split-failed', '切割音訊失敗');
      return;
    }

    yield { type: 'phase', phase: 'recognizing' };
    yield { type: 'progress', completed: 0, total: segments.length };
    const results: SegmentResult[] = [];
    const cuesheet = () => buildCuesheet({ segments, durationSeconds: video.durationSeconds, results });
    for (const [index, segment] of segments.entries()) {
      results.push({
        startSeconds: segment.startSeconds,
        track: await recognizeOrNull(recognizer, files[index]!, signal),
      });
      yield { type: 'progress', completed: results.length, total: segments.length };
      yield { type: 'cuesheet', cuesheet: cuesheet() };
    }

    yield { type: 'done', cuesheet: cuesheet() };
  } catch (error) {
    yield errorEvent(error, 'unexpected', '分析時發生未預期的錯誤');
  } finally {
    if (workDir !== null) {
      await removeWorkDir(workDir);
    }
  }
}

/**
 * 辨識失敗（包含限流）時視為無結果，任務繼續執行
 *
 * 限流時的重試在後續 ticket 加入
 */
async function recognizeOrNull(recognizer: Recognizer, file: string, signal?: AbortSignal) {
  try {
    return await recognizer.recognize(file, signal);
  } catch (error) {
    console.warn(`片段辨識失敗，視為無結果：${String(error)}`);
    return null;
  }
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
