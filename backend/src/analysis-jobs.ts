/**
 * 管理執行中的分析任務，讓事件串流可以在任何時間訂閱
 *
 * 訂閱時先重播目前的狀態（最後的階段、進度、曲目表與結束事件），再接著推送即時事件
 */

import { randomUUID } from 'node:crypto';
import type { AnalysisEvent } from './analysis-runner.ts';
import type { VideoInfo } from './video-probe.ts';

/** 執行一次分析任務，依序產出事件 */
export type RunAnalysis = (video: VideoInfo) => AsyncIterable<AnalysisEvent>;

export interface AnalysisJobs {
  /** 在背景開始一個分析任務，回傳任務 ID */
  start(video: VideoInfo): string;
  /**
   * 依序產出任務的事件，直到完成或錯誤事件為止；`signal` 中止時提早結束
   *
   * 找不到任務時回傳空值
   */
  events(jobId: string, signal?: AbortSignal): AsyncIterable<AnalysisEvent> | null;
}

export interface AnalysisJobsOptions {
  /** 任務結束後保留多久（毫秒），讓晚到的訂閱者仍能拿到結果 */
  retentionMs?: number;
}

const DEFAULT_RETENTION_MS = 10 * 60 * 1000;

type Listener = (event: AnalysisEvent) => void;

/** 重播時依這個順序送出各類型的最後一個事件 */
const REPLAY_ORDER: readonly AnalysisEvent['type'][] = ['phase', 'progress', 'cuesheet', 'done', 'error'];

class Job {
  private readonly latest = new Map<AnalysisEvent['type'], AnalysisEvent>();
  private readonly listeners = new Set<Listener>();
  finished = false;

  push(event: AnalysisEvent): void {
    if (this.finished) {
      return;
    }
    this.latest.set(event.type, event);
    this.finished = isTerminal(event);
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  snapshot(): AnalysisEvent[] {
    return REPLAY_ORDER.flatMap((type) => this.latest.get(type) ?? []);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function createAnalysisJobs(run: RunAnalysis, options: AnalysisJobsOptions = {}): AnalysisJobs {
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const jobs = new Map<string, Job>();

  async function execute(jobId: string, job: Job, video: VideoInfo): Promise<void> {
    try {
      for await (const event of run(video)) {
        job.push(event);
      }
    } catch (error) {
      job.push({ type: 'error', code: 'unexpected', message: '分析時發生未預期的錯誤', detail: String(error) });
    }
    if (!job.finished) {
      job.push({ type: 'error', code: 'unexpected', message: '分析任務意外中止' });
    }
    setTimeout(() => jobs.delete(jobId), retentionMs).unref();
  }

  return {
    start(video) {
      const jobId = randomUUID();
      const job = new Job();
      jobs.set(jobId, job);
      void execute(jobId, job, video);
      return jobId;
    },

    events(jobId, signal) {
      const job = jobs.get(jobId);
      return job === undefined ? null : follow(job, signal);
    },
  };
}

async function* follow(job: Job, signal?: AbortSignal): AsyncGenerator<AnalysisEvent, void, undefined> {
  const queue = job.snapshot();
  let wake: (() => void) | null = null;
  const unsubscribe = job.subscribe((event) => {
    queue.push(event);
    wake?.();
  });
  const onAbort = () => wake?.();
  signal?.addEventListener('abort', onAbort);

  try {
    while (signal?.aborted !== true) {
      const event = queue.shift();
      if (event === undefined) {
        await new Promise<void>((resolve) => (wake = resolve));
        wake = null;
        continue;
      }
      yield event;
      if (isTerminal(event)) {
        return;
      }
    }
  } finally {
    unsubscribe();
    signal?.removeEventListener('abort', onAbort);
  }
}

function isTerminal(event: AnalysisEvent): boolean {
  return event.type === 'done' || event.type === 'error';
}
