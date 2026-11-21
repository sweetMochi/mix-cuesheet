# 01：專案骨架與工具檢查

**What to build:** 使用者執行根目錄的啟動腳本後，用瀏覽器打開 `127.0.0.1` 上的網址，就會看到繁體中文的首頁。頁面會顯示 yt-dlp 和 FFmpeg 是否可用，缺少時會明確指出是哪一個工具。這張 ticket 要打通整條基礎路徑：Angular 前端呼叫 FastAPI 後端的健康檢查端點，後端則檢查系統 PATH 上的兩個 CLI 工具。開發時可以分開執行 `ng serve`（透過 proxy 轉發 `/api`）和後端；平常使用時由 FastAPI 直接提供 Angular build 後的靜態檔，只需要啟動一個程序

架構決策請參考 spec 的「整體架構」：Python 3.14、`venv` 加 `pip`、`requirements.txt` 以 `==` 鎖定版本、不使用 uv、最新版 Angular（standalone components 加 signals）、不使用 UI 元件庫、啟動腳本以 PowerShell 撰寫

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] 在現有資料夾執行 `git init`，沒有刪除 `.git` 內 Fork 的設定檔
- [ ] `.gitignore` 涵蓋 Python（含虛擬環境資料夾）與 Angular 的產出物；`.scratch/` 不被忽略
- [ ] repo 分為後端和前端兩個資料夾
- [ ] 後端依賴寫在 `requirements.txt`，每個套件都以 `==` 鎖定版本
- [ ] 後端有一個集中的設定模組，先放好 spec 列出的設定常數（片段長度 12 秒、步距 20 秒、長度上限 3 小時、同時請求數、重試次數）
- [ ] 健康檢查端點回報 yt-dlp 和 FFmpeg 個別是否可用
- [ ] 首頁以繁體中文顯示工具狀態；缺少工具時，錯誤訊息會指出是哪一個
- [ ] 啟動腳本在需要時建立 venv、安裝依賴、build 前端，然後啟動後端；使用者不需要手動啟用虛擬環境
- [ ] 後端只綁定 `127.0.0.1`
- [ ] `ng serve` 的 proxy 設定可以把 `/api` 轉到後端
- [ ] pytest 可以執行，並至少有一個測試通過（例如健康檢查端點的回應格式）
