# 後端執行環境實測記錄（2026-11-22）

評估後端是否從 Python 改為 Node.js（TypeScript）時做的實測。目的有三個：

1. 確認 Node.js 能不能完成 Shazam 辨識，並辨別限流
2. 確認 yt-dlp 和 FFmpeg 能不能改由 npm 套件提供，不依賴系統 PATH
3. 比較 Python 和 Node.js 遇到 Shazam 限流時的差異

是否改用 Node.js **尚未決定**，目前的決策見 [ADR 0001](../../adr/0001-backend-python-fastapi.md)

## 測試環境

| 項目 | 版本 |
|---|---|
| 作業系統 | Windows 11 Pro |
| Node.js | v24.20.0（直接執行 `.ts`） |
| npm | 11.19.0 |
| Python | 3.14.6 |

測試音訊：Rick Astley〈Never Gonna Give You Up〉（`dQw4w9WgXcQ`）的 12 秒片段，轉成 16 kHz 單聲道 WAV。「無結果」的對照組是用 FFmpeg 產生的 12 秒白噪音

## 實測一：Node.js 的 Shazam 辨識

腳本：[recognize-and-burst.ts](scripts/recognize-and-burst.ts)

用 `shazamio-core` 1.3.1（WASM 版）產生簽章，再用 Node 內建的 `fetch` 送出請求。請求的網址、標頭和 payload 對照 Python `shazamio` 0.9.0 的原始碼，兩者一致

| 測試音訊 | 結果 |
|---|---|
| 歌曲片段 | 200，辨識正確，回傳識別碼、演出者、曲名、Shazam 連結、封面網址 |
| 白噪音 | 200，`matches` 為 0 筆 |

- 12 秒的片段只產生 1 個簽章（11991 ms），一個片段送一次請求即可
- 被限流時回傳 HTTP 429，內容是 `text/html` 的「429 Too Many Requests」，**沒有 `Retry-After` 標頭**。只要檢查狀態碼就能辨別

現成套件 `node-shazam` 1.2.7 不適用：它不檢查 HTTP 狀態碼就直接解析 JSON，遇到限流只會丟出解析錯誤；deprecated 的 `fromFilePath` 還會把轉檔結果寫到固定檔名的暫存檔，並行時會互相覆蓋

**結論：可行**，辨識器的請求要自己寫，實驗腳本可以當雛形

## 實測二：Shazam 的限流

腳本：[recognize-and-burst.ts](scripts/recognize-and-burst.ts)、[rate-probe.ts](scripts/rate-probe.ts)

每次測試前先等 60～90 秒讓限流解除。第 2、3 種方式輪流送出 10 個不同的片段

| 送出方式 | 結果 |
|---|---|
| 並行度 3，連續送 30 個 | 1 個成功，29 個被限流（前兩個單獨測試的請求也算在同一段時間內） |
| 每 2 秒 1 個，共 15 個 | 前 3 個成功，之後連續被限流，大約 25 秒後才再成功 1 個 |
| 每 10 秒 1 個，共 10 個 | 7 個成功 |

推估的規則是：一開始可以連續送約 3 個，之後大約每 15～25 秒補 1 個名額。這只是從一個 IP、一個時段、少量請求得到的估計

**這和 spec #1 的假設差很多**：spec 設定「同時送 2～3 個請求、限流時重試 3 次」。照實測的速度，1 小時的混音（180 個片段）大約要 45～75 分鐘，3 小時的混音要 2～4 小時

## 實測三：Python 與 Node.js 的限流比較

腳本：[rate_probe.py](scripts/rate_probe.py)

用 Python 3.14.6、`shazamio` 0.9.0、`shazamio_core` 2.0.0 重做實測二的「每 2 秒 1 個」

**伺服器端的限流：沒有差異**

| | Node.js | Python |
|---|---|---|
| 成功 | 前 3 個 | 前 3 個 |
| 被限流 | 第 4 個起連續 429 | 第 4 個起連續 429 |
| `User-Agent` | 固定一個 | 每次隨機換 |

Python 版每次隨機換 `User-Agent`，結果也一樣，所以限流不是依 UA 計算的，和語言、套件都無關

**用戶端的處理：有差異**

| | Python `shazamio` 0.9.0 | Node.js 自己寫的請求 |
|---|---|---|
| 遇到 429 | 丟出 `RateLimited` 例外 | 自己檢查狀態碼 |
| 預設行為 | 在內部用指數退避自動重試最多 20 次，呼叫端看不到限流 | 不重試 |
| 實測（預設設定） | 被限流的請求在內部重試 9 次、耗時 53.7 秒後才成功 | 不適用 |
| 符合 spec 的做法 | 注入 `HTTPClient(retry_options=ExponentialRetry(attempts=1))`，實測後會立刻丟出 `RateLimited` | 檢查到 429 就丟出限流錯誤 |

不管用哪種語言，都要把重試的控制權交給任務執行器，才能顯示進度、即時取消，並在重試用完後把片段標成無結果

## 實測四：npm 套件提供 yt-dlp 和 FFmpeg

腳本：[tools-pipeline.ts](scripts/tools-pipeline.ts)

安裝 `ffmpeg-static` 5.3.0 和 `youtube-dl-exec` 3.1.19，子程序的 PATH 只保留 Node.js 和 Windows 系統資料夾，確保不會用到系統上另外安裝的 yt-dlp、FFmpeg 或 Deno

| 步驟 | 結果 |
|---|---|
| 安裝 | 下載了 FFmpeg 6.1.1（83 MB）和 yt-dlp 2026.10.26（24 MB） |
| 對照組：不啟用 JS runtime | 可以執行，但 yt-dlp 警告這種用法已淘汰，部分格式可能拿不到 |
| 用 Node 當 JS runtime 預先解析 | 通過，取得標題、長度（213 秒）、7 種純音訊格式，耗時 4.6 秒 |
| 下載最佳音質音訊 | 通過，3.4 MB 的 webm，耗時 11 秒 |
| 用 `ffmpeg-static` 切出 12 秒片段 | 通過，12.00 秒、16 kHz 單聲道 |
| 片段送去 Shazam | 辨識正確 |

- yt-dlp 官方執行檔內含 `yt-dlp-ejs`，加上 `--no-js-runtimes --js-runtimes node:<node.exe 路徑>` 就能用 Node 處理 YouTube 的 JS challenge，**不需要安裝 Deno**
- 每次呼叫 yt-dlp 都要傳 `--ffmpeg-location`，否則會警告找不到 FFmpeg，可能選不到最好的格式
- 執行檔支援 `yt-dlp.exe -U` 自我更新

**要注意的事**

- **yt-dlp 的版本不受 lockfile 鎖定**：`youtube-dl-exec` 的安裝腳本會向 GitHub API 下載「當下最新版」的 yt-dlp，之後就停在那個版本，直到重新安裝 `node_modules`。要鎖定版本得設定環境變數 `YOUTUBE_DL_HOST` 指向特定版本
- **npm 11 的安裝腳本核准**：npm 會警告這兩個套件的安裝腳本還沒列入 `allowScripts`。執行 `npm install-scripts approve <套件>` 後，核准紀錄會寫進 `package.json` 並綁定版本號，升級套件時要重新核准
- `npm ci` 不能加 `--ignore-scripts`，安裝時一定要能連網

## 結論

- Node.js 方案在技術上可行：Shazam 辨識、辨別限流、yt-dlp 和 FFmpeg 都改由 npm 套件提供，全部實測通過
- Shazam 的限流比 spec 假設的嚴格很多，這和語言無關，兩種方案都要重新設計送出速度和退避時間
- 兩種方案的實際差距主要是：Node.js 的 `shazamio-core` 從 2024-04 之後沒有更新，Shazam 請求要自己維護；Python 的 `shazamio` 社群會跟進 Shazam API 的改版

## 未決事項

- 後端是否改用 Node.js
- spec #1 的限流參數（同時請求數、重試次數、退避時間）、預估時間、長度上限、取樣步距
- yt-dlp 是否鎖定版本。傾向不鎖定，但要在啟動時自動執行 `-U` 更新、記錄版本、錯誤訊息要有退路，並在 spec 和 ADR 註明這是刻意的例外

## 重現方式

**準備測試音訊**（需要 yt-dlp 和 FFmpeg）：

```sh
yt-dlp -f bestaudio -o "full.%(ext)s" --download-sections "*40-100" "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
ffmpeg -ss 20 -t 12 -i full.webm -ac 1 -ar 16000 song12.wav
ffmpeg -f lavfi -i "anoisesrc=d=12:c=white:r=16000:a=0.3" -ac 1 noise12.wav
# rate-probe.ts 和 rate_probe.py 需要 10 個不同的片段
for i in 0 1 2 3 4 5 6 7 8 9; do ffmpeg -ss $((i*4)) -t 12 -i full.webm -ac 1 -ar 16000 clip$i.wav; done
```

**Node.js 腳本**（需要 Node.js 22.18 以上，在 `package.json` 設定 `"type": "module"`）：

```sh
npm install --save-exact shazamio-core@1.3.1 ffmpeg-static@5.3.0 youtube-dl-exec@3.1.19
node recognize-and-burst.ts <音訊資料夾> 30          # 實測一、實測二的並行測試
node rate-probe.ts <音訊資料夾> 60 2000 15           # 先等 60 秒，每 2 秒 1 個，共 15 個
node tools-pipeline.ts                               # 實測四
```

**Python 腳本**（需要 Python 3.14）：

```sh
python -m venv .venv
.venv/Scripts/python -m pip install shazamio==0.9.0
.venv/Scripts/python rate_probe.py raw <音訊資料夾> 90 2 15          # 停用自動重試
.venv/Scripts/python rate_probe.py default <音訊資料夾> 90 5 150     # shazamio 預設設定
```

Windows 終端機的編碼不是 UTF-8 時，Python 腳本的中文輸出會變成亂碼，先設定 `PYTHONIOENCODING=utf-8` 再執行

這些腳本會實際呼叫 Shazam 的非官方 API。限流測試會刻意送出大量請求，請不要頻繁執行
