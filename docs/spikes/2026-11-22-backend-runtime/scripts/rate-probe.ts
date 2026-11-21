// 觀察限流條件：等待一段時間後，以固定間隔逐一送出不同片段的辨識請求
// 用法：node probe.ts <音訊資料夾> <先等待秒數> <間隔毫秒> <請求數>
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import core from 'shazamio-core';

const { recognizeBytes } = core as typeof import('shazamio-core');

const [AUDIO_DIR, WAIT_S, INTERVAL_MS, COUNT] = [
  process.argv[2],
  Number(process.argv[3]),
  Number(process.argv[4]),
  Number(process.argv[5]),
];

const HEADERS = {
  'X-Shazam-Platform': 'IPHONE',
  'X-Shazam-AppVersion': '14.1.0',
  Accept: '*/*',
  'Accept-Language': 'en-US',
  'Content-Type': 'application/json',
  'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 5.0.2; VS980 4G Build/LRX22G)',
};

const signatures = Array.from({ length: 10 }, (_, i) => {
  const [s] = recognizeBytes(readFileSync(`${AUDIO_DIR}/clip${i}.wav`));
  const sig = { uri: s.uri, samplems: s.samplems };
  s.free();
  return sig;
});

console.log(`先等待 ${WAIT_S} 秒…`);
await sleep(WAIT_S * 1000);

const t0 = performance.now();
for (let i = 0; i < COUNT; i++) {
  const sig = signatures[i % signatures.length];
  const url =
    `https://amp.shazam.com/discovery/v5/en-US/US/iphone/-/tag/${randomUUID().toUpperCase()}/${randomUUID().toUpperCase()}` +
    '?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3&sharehub=true&hubv5minorversion=v5.1&hidelb=true&video=v3';
  const body = JSON.stringify({
    timezone: 'Asia/Taipei',
    signature: sig,
    timestamp: Date.now(),
    context: {},
    geolocation: {},
  });
  const res = await fetch(url, { method: 'POST', headers: HEADERS, body });
  const text = await res.text();
  const at = ((performance.now() - t0) / 1000).toFixed(1);
  let detail = '';
  if (res.status === 200) {
    const json = JSON.parse(text);
    detail = json.track ? `${json.track.subtitle} - ${json.track.title}` : '無結果';
  } else {
    const interesting = [...res.headers].filter(([k]) => /retry|rate|limit|cf-|server|x-/i.test(k));
    detail = JSON.stringify(Object.fromEntries(interesting));
  }
  console.log(`t=${at}s #${i + 1} clip${i % 10} → ${res.status} ${detail}`);
  await sleep(INTERVAL_MS);
}
