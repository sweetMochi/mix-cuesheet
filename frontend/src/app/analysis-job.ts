import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiError, toApiError } from './api-error';

export type AnalysisPhase = 'downloading' | 'splitting' | 'recognizing';

export interface RecognizedTrack {
  trackId: string;
  artist: string;
  title: string;
  /** 曲目在 Shazam 的頁面 */
  shazamUrl: string;
  /** 封面網址；可能為空值 */
  coverUrl: string | null;
}

/** 一首曲目；整支影片中命中同一首的片段都併入這一列 */
export interface TrackRow {
  kind: 'track';
  /** 最早一次命中的片段起始秒數 */
  startSeconds: number;
  /** 後端格式化好的開始時間，例如 `12:40`、`1:02:03` */
  startText: string;
  track: RecognizedTrack;
  /** 整支影片中命中這首曲目的片段數 */
  hitCount: number;
  /** 「僅命中 1 次」標記 */
  singleHit: boolean;
}

/** 連續 2 個以上的無結果片段合併成的「未辨識」區間 */
export interface UnrecognizedRow {
  kind: 'unrecognized';
  startSeconds: number;
  startText: string;
  endSeconds: number;
  endText: string;
}

export type CuesheetRow = TrackRow | UnrecognizedRow;

export interface Cuesheet {
  rows: CuesheetRow[];
}

export interface AnalysisProgress {
  completed: number;
  total: number;
}

/** 任務事件串流推送的事件，與後端的 `AnalysisEvent` 一致 */
type AnalysisEvent =
  | { type: 'phase'; phase: AnalysisPhase }
  | ({ type: 'progress' } & AnalysisProgress)
  | { type: 'cuesheet'; cuesheet: Cuesheet }
  | { type: 'done'; cuesheet: Cuesheet }
  | { type: 'error'; code: string; message: string; detail?: string }
  | { type: 'cancelled' };

/** 後端以 SSE 的 `event:` 欄位標示事件類型；`error` 另外處理 */
const EVENT_TYPES: readonly AnalysisEvent['type'][] = ['phase', 'progress', 'cuesheet', 'done', 'cancelled'];

export type AnalysisStatus = 'starting' | 'running' | 'done' | 'failed' | 'cancelled';

const CONNECTION_LOST: ApiError = {
  code: 'connection-lost',
  message: '與後端的連線中斷，分析結果已無法取得，請確認後端程序仍在執行後重新分析',
};

/**
 * 一次分析任務在前端的狀態
 *
 * 建立任務後以 EventSource 訂閱事件串流，並把事件轉成 signals
 */
export class AnalysisRun {
  private readonly _status = signal<AnalysisStatus>('starting');
  private readonly _phase = signal<AnalysisPhase | null>(null);
  private readonly _progress = signal<AnalysisProgress | null>(null);
  private readonly _rows = signal<CuesheetRow[]>([]);
  private readonly _error = signal<ApiError | null>(null);
  private readonly _reconnecting = signal(false);
  private readonly _cancelling = signal(false);
  private readonly _cancelError = signal<ApiError | null>(null);

  readonly status = this._status.asReadonly();
  readonly phase = this._phase.asReadonly();
  readonly progress = this._progress.asReadonly();
  /** 最新的曲目表；每次收到快照時整份替換 */
  readonly rows = this._rows.asReadonly();
  readonly error = this._error.asReadonly();
  /** 連線暫時中斷，EventSource 正在自動重新連線 */
  readonly reconnecting = this._reconnecting.asReadonly();
  /** 已經要求取消，正在等後端停止任務 */
  readonly cancelling = this._cancelling.asReadonly();
  /** 取消請求失敗的原因；任務仍在執行 */
  readonly cancelError = this._cancelError.asReadonly();

  private jobId: string | null = null;
  private source: EventSource | null = null;
  private closed = false;

  constructor(
    private readonly http: HttpClient,
    readonly videoId: string,
  ) {
    void this.begin();
  }

  /** 停止接收事件；不會停止後端的任務 */
  close(): void {
    this.closed = true;
    this.source?.close();
    this.source = null;
  }

  /**
   * 要求後端取消任務；任務停止後會收到已取消事件
   *
   * 任務還在建立中時，等拿到任務 ID 後再送出取消
   */
  async cancel(): Promise<void> {
    const status = this._status();
    if (this._cancelling() || (status !== 'starting' && status !== 'running')) {
      return;
    }
    this._cancelling.set(true);
    this._cancelError.set(null);
    if (this.jobId !== null) {
      await this.requestCancel(this.jobId);
    }
  }

  private async requestCancel(jobId: string): Promise<void> {
    try {
      await firstValueFrom(this.http.delete(`/api/jobs/${encodeURIComponent(jobId)}`));
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 404) {
        // 後端已經沒有這個任務，不會再送出任何事件
        this.finish('cancelled');
        return;
      }
      this._cancelling.set(false);
      this._cancelError.set(toApiError(error));
    }
  }

  private async begin(): Promise<void> {
    let jobId: string;
    try {
      const response = await firstValueFrom(
        this.http.post<{ jobId: string }>('/api/jobs', { videoId: this.videoId }),
      );
      jobId = response.jobId;
    } catch (error) {
      this.fail(toApiError(error));
      return;
    }
    if (this.closed) {
      return;
    }

    this.jobId = jobId;
    if (this._cancelling()) {
      void this.requestCancel(jobId);
    }
    this._status.set('running');
    const source = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`);
    this.source = source;

    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (event) => this.receive(event as MessageEvent<string>));
    }

    // 後端的錯誤事件名稱也是 `error`，和 EventSource 本身的連線錯誤共用同一個事件名稱：
    // 帶有資料的 MessageEvent 是分析錯誤，其他的是連線錯誤
    source.addEventListener('error', (event) => {
      if (event instanceof MessageEvent && typeof event.data === 'string') {
        this.receive(event);
      } else if (source.readyState === EventSource.CLOSED) {
        this.fail(CONNECTION_LOST);
      } else {
        this._reconnecting.set(true);
      }
    });
  }

  private receive(message: MessageEvent<string>): void {
    this._reconnecting.set(false);
    const event = JSON.parse(message.data) as AnalysisEvent;
    switch (event.type) {
      case 'phase':
        this._phase.set(event.phase);
        break;
      case 'progress':
        this._progress.set({ completed: event.completed, total: event.total });
        break;
      case 'cuesheet':
        this._rows.set(event.cuesheet.rows);
        break;
      case 'done':
        this._rows.set(event.cuesheet.rows);
        this.finish('done');
        break;
      case 'error':
        this.fail({ code: event.code, message: event.message, detail: event.detail });
        break;
      case 'cancelled':
        this.finish('cancelled');
        break;
    }
  }

  private fail(error: ApiError): void {
    this._error.set(error);
    this.finish('failed');
  }

  /** 進入結束狀態；後端送完結束事件後會關閉串流，要先關掉 EventSource，避免它自動重新連線 */
  private finish(status: 'done' | 'failed' | 'cancelled'): void {
    this._reconnecting.set(false);
    this._cancelling.set(false);
    this._cancelError.set(null);
    this._status.set(status);
    this.close();
  }
}

@Injectable({ providedIn: 'root' })
export class AnalysisJobService {
  private readonly http = inject(HttpClient);

  /** 建立分析任務並開始接收事件 */
  start(videoId: string): AnalysisRun {
    return new AnalysisRun(this.http, videoId);
  }
}
