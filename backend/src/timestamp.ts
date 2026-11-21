/**
 * 把秒數格式化成 YouTube 能辨識的時間戳記
 *
 * 未滿 1 小時用 `MM:SS`（例如 `00:00`、`12:40`），1 小時以上用 `H:MM:SS`（例如 `1:02:03`）。
 * 不足 1 秒的部分捨去
 */
export function formatTimestamp(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const mmss = `${pad(minutes)}:${pad(rest)}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
