import { Component, computed, inject, signal } from '@angular/core';
import { healthResource } from './health';
import { ProbeError, ProbeState, VideoProbeService } from './video-probe';

@Component({
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {
  private readonly videoProbe = inject(VideoProbeService);

  protected readonly health = healthResource();

  protected readonly missingTools = computed(() =>
    (this.health.value()?.tools ?? []).filter((tool) => !tool.available).map((tool) => tool.name),
  );

  protected readonly url = signal('');
  protected readonly probe = signal<ProbeState>({ status: 'idle' });

  protected readonly isProbing = computed(() => this.probe().status === 'probing');
  protected readonly video = computed(() => {
    const state = this.probe();
    return state.status === 'ready' ? state.video : null;
  });
  protected readonly probeError = computed(() => {
    const state = this.probe();
    return state.status === 'failed' ? state.error : null;
  });
  protected readonly canSubmit = computed(() => !this.isProbing() && this.url().trim() !== '');

  protected onUrlInput(event: Event): void {
    this.url.set((event.target as HTMLInputElement).value);
  }

  protected async submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!this.canSubmit()) {
      return;
    }

    this.probe.set({ status: 'probing' });
    try {
      const video = await this.videoProbe.probe(this.url().trim());
      this.probe.set({ status: 'ready', video });
    } catch (error) {
      this.probe.set({ status: 'failed', error: error as ProbeError });
    }
  }

  protected youtubeUrl(videoId: string): string {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  }
}
