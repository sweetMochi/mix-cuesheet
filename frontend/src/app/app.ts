import { Component, computed, ElementRef, inject, signal, viewChild } from '@angular/core';
import { AnalysisJobService, AnalysisPhase, AnalysisRun } from './analysis-job';
import { ApiError } from './api-error';
import { healthResource } from './health';
import { ProbeState, VideoProbeService } from './video-probe';

const PHASE_TEXT: Record<AnalysisPhase, string> = {
  downloading: '正在下載音訊',
  splitting: '正在切割片段',
  recognizing: '正在辨識曲目',
};

@Component({
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {
  private readonly videoProbe = inject(VideoProbeService);
  private readonly analysisJobs = inject(AnalysisJobService);

  private readonly urlInput = viewChild.required<ElementRef<HTMLInputElement>>('urlInput');

  protected readonly health = healthResource();

  protected readonly missingTools = computed(() =>
    (this.health.value()?.tools ?? []).filter((tool) => !tool.available).map((tool) => tool.name),
  );

  protected readonly url = signal('');
  protected readonly probe = signal<ProbeState>({ status: 'idle' });
  protected readonly run = signal<AnalysisRun | null>(null);

  protected readonly isProbing = computed(() => this.probe().status === 'probing');
  protected readonly isAnalyzing = computed(() => {
    const status = this.run()?.status();
    return status === 'starting' || status === 'running';
  });
  protected readonly isFinished = computed(() => {
    const status = this.run()?.status();
    return status === 'done' || status === 'failed';
  });
  protected readonly isBusy = computed(() => this.isProbing() || this.isAnalyzing());
  /** 曲目表中的曲目數，不含「未辨識」列 */
  protected readonly trackCount = computed(
    () => (this.run()?.rows() ?? []).filter((row) => row.kind === 'track').length,
  );

  protected readonly video = computed(() => {
    const state = this.probe();
    return state.status === 'ready' ? state.video : null;
  });
  protected readonly probeError = computed(() => {
    const state = this.probe();
    return state.status === 'failed' ? state.error : null;
  });
  protected readonly canSubmit = computed(() => !this.isBusy() && this.url().trim() !== '');

  protected readonly phaseText = computed(() => {
    const run = this.run();
    if (run === null || run.status() === 'starting') {
      return '正在建立分析任務';
    }
    const phase = run.phase();
    return phase === null ? '等待後端回應' : PHASE_TEXT[phase];
  });
  /** 辨識進度的百分比，0～100 */
  protected readonly progressPercent = computed(() => {
    const progress = this.run()?.progress();
    if (!progress || progress.total === 0) {
      return 0;
    }
    return Math.round((progress.completed / progress.total) * 100);
  });

  protected onUrlInput(event: Event): void {
    this.url.set((event.target as HTMLInputElement).value);
  }

  protected async submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!this.canSubmit()) {
      return;
    }

    this.clearRun();
    this.probe.set({ status: 'probing' });
    try {
      const video = await this.videoProbe.probe(this.url().trim());
      this.probe.set({ status: 'ready', video });
    } catch (error) {
      this.probe.set({ status: 'failed', error: error as ApiError });
    }
  }

  protected startAnalysis(): void {
    const video = this.video();
    if (video === null || this.isBusy()) {
      return;
    }
    this.clearRun();
    this.run.set(this.analysisJobs.start(video.videoId));
  }

  /** 回到輸入網址的狀態，準備分析另一支影片 */
  protected reset(): void {
    this.clearRun();
    this.probe.set({ status: 'idle' });
    this.url.set('');
    this.urlInput().nativeElement.focus();
  }

  protected youtubeUrl(videoId: string, startSeconds?: number): string {
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    return startSeconds === undefined ? url : `${url}&t=${startSeconds}s`;
  }

  private clearRun(): void {
    this.run()?.close();
    this.run.set(null);
  }
}
