import { existsSync } from 'node:fs';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import type { ToolStatus } from './tools.ts';

export interface HealthResponse {
  ok: boolean;
  tools: ToolStatus[];
  /** 啟動時取得的 yt-dlp 版本；無法取得時為空值 */
  ytDlpVersion: string | null;
}

export interface AppDeps {
  checkTools: () => ToolStatus[];
  ytDlpVersion: string | null;
  /** Angular build 後的靜態檔位置；空值或資料夾不存在時只提供 API */
  frontendDistDir: string | null;
}

/** 建立 Hono app；相依由外部注入，測試時不需要啟動伺服器 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get('/api/health', (c) => {
    const tools = deps.checkTools();
    return c.json<HealthResponse>({
      ok: tools.every((tool) => tool.available),
      tools,
      ytDlpVersion: deps.ytDlpVersion,
    });
  });

  // 平常使用時由後端直接提供 Angular build 後的靜態檔；開發時改用 ng serve
  if (deps.frontendDistDir !== null && existsSync(deps.frontendDistDir)) {
    app.use('/*', serveStatic({ root: deps.frontendDistDir }));
  }

  return app;
}
