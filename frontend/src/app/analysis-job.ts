import { HttpClient } from '@angular/common/http';
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

export interface TrackRow {
  kind: 'track';
  /** 第一次命中的片段起始秒數 */
  startSeconds: number;
  /** 後端格式化好的開始時間，例如 `12:40`、`1:02:03` */
  startText: string;
  track: RecognizedTrack;
  /** 併入這一列的片段數 */
  hitCount: number;
}

export type CuesheetRow = TrackRow;

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
  | { type: 'error'; code: string; message: string; detail?: string };

/** 後端以 SSE 的 `event:` 欄位標示事件類型 */
const EVENT_TYPES: readonly AnalysisEvent['type'][] = ['phase', 'progress', 'cuesheet', 'done'];

export type AnalysisStatus = 'starting' | 'running' | 'done' | 'failed';

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

  readonly status = this._status.asReadonly();
  readonly phase = this._phase.asReadonly();
  readonly progress = this._progress.asReadonly();
  /** 最新的曲目表；每次收到快照時整份替換 */
  readonly rows = this._rows.asReadonly();
  readonly error = this._error.asReadonly();
  /** 連線暫時中斷，EventSource 正在自動重新連線 */
  readonly reconnecting = this._reconnecting.asReadonly();

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
        this._status.set('done');
        // 後端送完結束事件後會關閉串流，要先關掉 EventSource，避免它自動重新連線
        this.close();
        break;
      case 'error':
        this.fail({ code: event.code, message: event.message, detail: event.detail });
        break;
    }
  }

  private fail(error: ApiError): void {
    this._reconnecting.set(false);
    this._error.set(error);
    this._status.set('failed');
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
