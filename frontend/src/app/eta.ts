/**
 * 辨識階段的剩餘時間預估
 *
 * 實際速度由 Shazam 的限流決定，無法事先得知，所以只能依最近幾段實際完成的速度推算
 */

/** 收到進度事件時記下的完成片段數與時間 */
export interface ProgressSample {
  completed: number;
  /** 收到事件的時間（毫秒） */
  at: number;
}

/**
 * Shazam 一開始可以連續送出約 3 個請求，之後才受限流控制（見 docs/spikes/2026-11-22-backend-runtime/README.md），
 * 這幾段幾乎同時完成，算進速度會讓預估偏樂觀，所以從這幾段完成之後才開始計算
 */
const BURST_SEGMENTS = 3;

/** 計速期間至少再完成幾段才開始預估 */
const MIN_MEASURED_SEGMENTS = 2;

/** 以最近幾段的速度預估，讓速度改變時預估能跟上 */
const WINDOW_SEGMENTS = 20;

/** 保留最近的進度紀錄，只留預估需要的數量 */
export function addProgressSample(samples: readonly ProgressSample[], sample: ProgressSample): ProgressSample[] {
  const last = samples.at(-1);
  // 新任務從 0 開始；一開始連續完成的幾段只當作計速的起點
  if (last === undefined || sample.completed < last.completed || sample.completed <= BURST_SEGMENTS) {
    return [sample];
  }
  // 重新連線時後端會重播相同的進度，不算新的完成
  if (sample.completed === last.completed) {
    return [...samples];
  }
  return [...samples, sample].slice(-(WINDOW_SEGMENTS + 1));
}

/**
 * 預估剩餘的毫秒數；完成的片段還不夠時回傳空值
 *
 * 從上一段完成後經過的時間會扣掉，所以預估會隨時間倒數；
 * 但最多只扣掉一段的時間，等待中的這一段比平常久時，預估停在剩下的片段數所需的時間，不會一路倒數到 0
 */
export function estimateRemainingMs(samples: readonly ProgressSample[], total: number, now: number): number | null {
  const first = samples[0];
  const last = samples.at(-1);
  if (first === undefined || last === undefined || last.completed - first.completed < MIN_MEASURED_SEGMENTS) {
    return null;
  }
  const msPerSegment = (last.at - first.at) / (last.completed - first.completed);
  const left = total - last.completed;
  if (left <= 0) {
    return 0;
  }
  return Math.max(msPerSegment * left - (now - last.at), msPerSegment * (left - 1), 0);
}

/** 以 `M:SS` 或 `H:MM:SS` 顯示剩餘時間，無條件進位到秒 */
export function formatRemaining(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}
