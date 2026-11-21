---
status: accepted
---

# 後端改用 Node.js 與 Hono

2026-11-22 決定後端由 Python（FastAPI）改為 Node.js 加 TypeScript，Web 框架用 Hono。[ADR 0001](0001-backend-python-fastapi.md) 選用 Python 的主要理由是 `shazamio` 只有 Python 版本；當天的實測證實 Node.js 也能完成 Shazam 辨識，yt-dlp 和 FFmpeg 也能改由 npm 套件提供，這個理由就不再是限制。實測紀錄見 [後端執行環境實測記錄](../spikes/2026-11-22-backend-runtime/README.md)

## 為什麼 Python 的理由不再成立

- **Shazam 辨識**：`shazamio-core` 1.3.1（WASM 版）在 Node v24.20.0 下產生的簽章 Shazam 接受，辨識結果正確；請求格式照抄 Python `shazamio`，用 `fetch` 大約 30 行就能完成，也能從 HTTP 429 辨別限流
- **Python 版也要客製化**：`shazamio` 預設會對 429 在內部自動重試最多 20 次，呼叫端看不到限流。spec 要求任務執行器自己處理限流，所以 Python 版也得替換它的 HTTP client，`shazamio` 能省下的工作比原本以為的少
- **外部工具**：`ffmpeg-static` 和 `youtube-dl-exec` 在只有 Node.js 的環境下就能完成預先解析、下載和切段；yt-dlp 可以用 Node.js 當 JS runtime，不需要安裝 Deno
- **限流和語言無關**：Python 和 Node.js 在相同條件下被限流的方式完全相同

## 評估時列出的好處

- 前後端都用 TypeScript，API 契約的型別可以共用
- 啟動腳本只需要 Node.js，不用再找 Python 3.14、建立 venv
- 測試用 Vitest，和 Angular 預設的測試工具相同

## 技術選擇

- **執行環境**：Node.js 22.18 以上，直接執行 `.ts` 檔，不需要 build 步驟
- **Web 框架**：Hono 加 `@hono/node-server`。內建 `streamSSE` 和 `serveStatic`，寫法最接近原本的 FastAPI。Fastify 也可行，但 SSE 要自己處理 `reply.raw`
- **驗證**：Zod
- **測試**：Vitest，用 `createApp(deps)` 注入相依，再以 `app.request()` 測試端點
- **依賴管理**：npm，`package.json` 以確切版本鎖定，提交 `package-lock.json`

## Considered Options

- **維持 Python**：`shazamio` 有社群跟進 Shazam API 的改版，這是 Node.js 方案沒有的優勢。沒有選擇的原因見上面「為什麼 Python 的理由不再成立」
- **Node.js 用 `node-shazam`**：它不檢查 HTTP 狀態碼就直接解析 JSON，限流時只會丟出解析錯誤，無法辨別；deprecated 的函式還會把轉檔結果寫到固定檔名的暫存檔，並行時會互相覆蓋

## Consequences

- **Shazam 請求要自己維護**：`shazamio-core` 的 WASM 版從 2024-04 之後就沒有更新，版本也落後 Python 版（2.0.0）。Shazam 改版時，要參考 Python `shazamio` 的更新內容自己修改請求。辨識器以介面隔離，替換實作時不需要動到任務執行器
- **yt-dlp 不鎖定版本**：這是依賴鎖定規則的刻意例外。YouTube 經常變動，舊版 yt-dlp 很容易下載失敗；`youtube-dl-exec` 只在安裝時下載當下最新版，所以啟動腳本每次啟動都要執行 `yt-dlp -U`，失敗時只顯示警告。代價是 yt-dlp 的錯誤訊息可能改變，錯誤對應要有退路，出問題時也要從 log 裡的版本判斷原因
- **安裝腳本要核准**：`ffmpeg-static` 和 `youtube-dl-exec` 靠安裝腳本下載執行檔。npm 11 要用 `npm install-scripts approve` 核准，核准紀錄綁定版本號，升級時要重新核准；`npm ci` 也不能加 `--ignore-scripts`
- **FFmpeg 版本較舊**：`ffmpeg-static` 5.3.0 提供的是 FFmpeg 6.1.1（2023 年），切段沒有問題，需要新功能時再換套件
- **既有的 Python 實作要改寫**：ticket 01 的 Python 版實作已經在 commit `2208934` 提交，要依 issue #2 改寫成 Node.js 版
