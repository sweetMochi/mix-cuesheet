// 實驗：在 Node.js 下用 shazamio-core（WASM）產生簽章，自己用 fetch 呼叫 Shazam 辨識
// 驗證 1：簽章能產生，且 Shazam 接受、能辨識出正確曲目
// 驗證 2：觀察每個請求的 HTTP 狀態碼與內容類型，確認能否辨別限流
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import core from 'shazamio-core';

const { recognizeBytes } = core as typeof import('shazamio-core');

const AUDIO_DIR = process.argv[2];
const BURST_REQUESTS = Number(process.argv[3] ?? 30);
const BURST_CONCURRENCY = 3;

const URL_TEMPLATE =
  'https://amp.shazam.com/discovery/v5/en-US/US/iphone/-/tag/{u1}/{u2}' +
  '?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3&sharehub=true&hubv5minorversion=v5.1&hidelb=true&video=v3';

const HEADERS = {
  'X-Shazam-Platform': 'IPHONE',
  'X-Shazam-AppVersion': '14.1.0',
  Accept: '*/*',
  'Accept-Language': 'en-US',
  'Content-Type': 'application/json',
  'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 5.0.2; VS980 4G Build/LRX22G)',
};

interface Signature {
  uri: string;
  samplems: number;
}

function signaturesOf(file: string): Signature[] {
  const decoded = recognizeBytes(readFileSync(file));
  const result = decoded.map((s) => ({ uri: s.uri, samplems: s.samplems }));
  for (const s of decoded) s.free();
  return result;
}

interface Outcome {
  status: number;
  contentType: string | null;
  ms: number;
  track?: { key: string; title: string; subtitle: string; url?: string; coverart?: string };
  matches?: number;
  rawSnippet?: string;
}

async function recognize(sig: Signature): Promise<Outcome> {
  const url = URL_TEMPLATE.replace('{u1}', randomUUID().toUpperCase()).replace('{u2}', randomUUID().toUpperCase());
  const body = JSON.stringify({
    timezone: 'Asia/Taipei',
    signature: { uri: sig.uri, samplems: sig.samplems },
    timestamp: Date.now(),
    context: {},
    geolocation: {},
  });
  const started = performance.now();
  const response = await fetch(url, { method: 'POST', headers: HEADERS, body });
  const ms = Math.round(performance.now() - started);
  const contentType = response.headers.get('content-type');
  const text = await response.text();
  const outcome: Outcome = { status: response.status, contentType, ms };
  if (response.status !== 200 || !contentType?.includes('json')) {
    outcome.rawSnippet = text.slice(0, 300);
    return outcome;
  }
  const json = JSON.parse(text);
  outcome.matches = json.matches?.length ?? 0;
  if (json.track) {
    outcome.track = {
      key: json.track.key,
      title: json.track.title,
      subtitle: json.track.subtitle,
      url: json.track.url,
      coverart: json.track.images?.coverart,
    };
  }
  return outcome;
}

async function main() {
  console.log(`Node ${process.version}`);

  // --- 驗證 1：簽章與辨識 ---
  for (const name of ['song12.wav', 'noise12.wav']) {
    const sigs = signaturesOf(`${AUDIO_DIR}/${name}`);
    console.log(`\n[${name}] 簽章數：${sigs.length}，各段長度（ms）：${sigs.map((s) => s.samplems).join(', ')}`);
    const outcome = await recognize(sigs[0]);
    console.log(JSON.stringify(outcome, null, 2));
  }

  // --- 驗證 2：以專案的並行度連續送出，記錄狀態碼 ---
  const sig = signaturesOf(`${AUDIO_DIR}/song12.wav`)[0];
  console.log(`\n連續送出 ${BURST_REQUESTS} 個請求，並行度 ${BURST_CONCURRENCY}`);
  const outcomes: Outcome[] = [];
  let next = 0;
  const worker = async () => {
    while (next < BURST_REQUESTS) {
      next++;
      try {
        outcomes.push(await recognize(sig));
      } catch (error) {
        outcomes.push({ status: -1, contentType: null, ms: 0, rawSnippet: String(error) });
      }
    }
  };
  const burstStarted = performance.now();
  await Promise.all(Array.from({ length: BURST_CONCURRENCY }, worker));
  const seconds = ((performance.now() - burstStarted) / 1000).toFixed(1);

  const byStatus = new Map<string, number>();
  for (const o of outcomes) {
    const k = `${o.status} ${o.contentType ?? ''}`;
    byStatus.set(k, (byStatus.get(k) ?? 0) + 1);
  }
  console.log(`耗時 ${seconds} 秒`);
  console.log('狀態碼統計：', Object.fromEntries(byStatus));
  console.log('辨識到的曲目：', [...new Set(outcomes.map((o) => o.track?.title ?? '(無)'))]);
  const latencies = outcomes.filter((o) => o.status === 200).map((o) => o.ms).sort((a, b) => a - b);
  if (latencies.length) {
    console.log(`延遲 ms：最小 ${latencies[0]}，中位數 ${latencies[Math.floor(latencies.length / 2)]}，最大 ${latencies.at(-1)}`);
  }
  for (const o of outcomes.filter((o) => o.rawSnippet)) {
    console.log('非 200 回應：', o.status, o.contentType, o.rawSnippet);
  }
}

await main();
