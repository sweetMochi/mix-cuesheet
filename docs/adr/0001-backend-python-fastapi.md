---
status: accepted
---

# 後端使用 Python 3.14 與 FastAPI

mix-cuesheet 的核心功能是把混音影片的片段送去 Shazam 辨識，而 spec（#1）指定的辨識器實作是 `shazamio`，這是 Python 套件，所以後端語言跟著它決定為 Python，框架選 FastAPI。決策當時（2026-11-21）已實測 `shazamio` 0.9.0 與 `shazamio-core` 2.0.0 在 Python 3.14 下可以正常安裝並呼叫 Shazam API，因此版本定為 3.14

## 決策流程

1. **先決定辨識方式**：用 `shazamio` 呼叫 Shazam 辨識片段，這是整個 App 最難替換的部分
2. **再由依賴決定語言**：`shazamio` 只有 Python 版本，選其他語言就要自己重寫 Shazam 的簽章與 API 呼叫，或在兩種語言之間多架一層橋接
3. **確認版本相容**：實測 `shazamio` 與它的原生擴充 `shazamio-core` 在 Python 3.14 下可以安裝與呼叫，才定下 3.14
4. **確認其他外部工具不影響選擇**：yt-dlp 與 FFmpeg 都以子程序呼叫系統 PATH 上的 CLI，不是 Python 依賴，換成哪種語言都一樣能呼叫

spec 沒有記錄和其他後端語言的正式比較；最容易被提出的替代方案是和 Angular 前端共用 TypeScript 的 Node.js 後端，沒有採用的原因就是上面第 2 點

## 選 FastAPI 的理由

以下理由是從 spec 的需求推得，不是當時逐條討論的結論：

- `shazamio` 是 async API，FastAPI 建立在 `asyncio` 上，有上限的並行辨識、限流時的指數退避重試、取消任務與中止子程序都能直接用 `asyncio` 處理
- spec 的任務事件以 SSE 推送，FastAPI 可以直接回傳串流回應
- 平常使用時由 FastAPI 直接提供 Angular build 後的靜態檔，只需啟動一個程序
- 分析任務執行器要能注入假的音訊來源、辨識器與退避等待，pytest 可以直接測試 async 函式

## Consequences

- `shazamio` 使用非官方 Shazam API，隨時可能被限流或改版。辨識器以介面隔離，替換實作時不需要動到任務執行器；但如果之後改用沒有 Python 版本的辨識服務，選用 Python 的主要理由就不存在了，到時候應重新評估這份 ADR
- 啟動腳本只接受 Python 3.14（[start.ps1](../../start.ps1) 的 `Find-Python`），升級 Python 版本前要先確認 `shazamio-core` 的原生擴充在新版本下可以安裝
- 環境管理採用 Python 內建的 `venv` 加 `pip`，依賴在 `requirements.txt` 以 `==` 鎖定版本，不使用 uv
