import { Component, computed } from '@angular/core';
import { healthResource } from './health';

@Component({
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {
  protected readonly health = healthResource();

  protected readonly missingTools = computed(() =>
    (this.health.value()?.tools ?? []).filter((tool) => !tool.available).map((tool) => tool.name),
  );
}
