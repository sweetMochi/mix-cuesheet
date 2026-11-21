"""集中管理後端的設定常數

取樣參數與伺服器設定都放在這裡，調整時只需要改這個檔案
"""

from pathlib import Path

# --- 伺服器 ---

# 只綁定本機，區網內的其他裝置無法存取
HOST = "127.0.0.1"
PORT = 8765

# Angular build 後的靜態檔位置；不存在時後端只提供 API
FRONTEND_DIST_DIR = Path(__file__).resolve().parents[2] / "frontend" / "dist" / "frontend" / "browser"

# --- 取樣與辨識 ---

# 每個片段的長度（秒）
SEGMENT_SECONDS = 12

# 相鄰片段起始時間的間隔（秒）
STEP_SECONDS = 20

# 混音影片長度上限（秒），超過直接拒絕
MAX_DURATION_SECONDS = 3 * 60 * 60

# 同時送往 Shazam 的辨識請求數
SHAZAM_CONCURRENCY = 2

# 遇到限流時的重試次數（指數退避）
SHAZAM_RETRY_ATTEMPTS = 3

# --- 外部工具 ---

# 必須存在於系統 PATH 上的 CLI 工具：顯示名稱 → 執行檔名稱
REQUIRED_TOOLS = {
    "yt-dlp": "yt-dlp",
    "FFmpeg": "ffmpeg",
}
