"""比較 Python shazamio 遇到限流時的行為

用法：
  python probe.py raw <音訊資料夾> <先等待秒數> <間隔秒數> <請求數>
    停用 shazamio 的自動重試，以固定間隔逐一送出，觀察伺服器的限流（和 Node 版 probe.ts 相同條件）
  python probe.py default <音訊資料夾> <先等待秒數> <請求數> <單一請求上限秒數>
    使用 shazamio 預設設定（429 自動重試最多 20 次），連續送出，觀察使用者實際感受到的耗時
"""

import asyncio
import logging
import sys
import time

from aiohttp_retry import ExponentialRetry
from shazamio import HTTPClient, Shazam
from shazamio.exceptions import RateLimited


class AttemptCounter(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.count = 0

    def emit(self, record: logging.LogRecord) -> None:
        self.count += 1


def describe(answer: dict) -> str:
    track = answer.get("track")
    return f"{track['subtitle']} - {track['title']}" if track else "無結果"


async def raw(audio: str, wait: float, interval: float, count: int) -> None:
    client = HTTPClient(retry_options=ExponentialRetry(attempts=1))
    async with Shazam(http_client=client) as shazam:
        print(f"先等待 {wait} 秒…", flush=True)
        await asyncio.sleep(wait)
        t0 = time.perf_counter()
        for i in range(count):
            clip = f"{audio}/clip{i % 10}.wav"
            try:
                result = describe(await shazam.recognize(clip))
                status = 200
            except RateLimited:
                result, status = "RateLimited 例外", 429
            print(f"t={time.perf_counter() - t0:.1f}s #{i + 1} clip{i % 10} → {status} {result}", flush=True)
            await asyncio.sleep(interval)
    await client.close()


async def default(audio: str, wait: float, count: int, cap: float) -> None:
    counter = AttemptCounter()
    logger = logging.getLogger("shazamio.request")
    logger.setLevel(logging.DEBUG)
    logger.addHandler(counter)
    async with Shazam() as shazam:
        print(f"先等待 {wait} 秒…", flush=True)
        await asyncio.sleep(wait)
        t0 = time.perf_counter()
        for i in range(count):
            before = counter.count
            started = time.perf_counter()
            try:
                result = describe(await asyncio.wait_for(shazam.recognize(f"{audio}/clip{i % 10}.wav"), cap))
            except TimeoutError:
                result = f"超過 {cap:.0f} 秒仍未完成（被中止）"
            except RateLimited:
                result = "RateLimited 例外（重試用完）"
            elapsed = time.perf_counter() - started
            print(
                f"t={time.perf_counter() - t0:.1f}s #{i + 1} clip{i % 10} → {result}，"
                f"耗時 {elapsed:.1f} 秒，送出 {counter.count - before} 次 HTTP 請求",
                flush=True,
            )


if __name__ == "__main__":
    mode, audio, *rest = sys.argv[1:]
    if mode == "raw":
        asyncio.run(raw(audio, float(rest[0]), float(rest[1]), int(rest[2])))
    else:
        asyncio.run(default(audio, float(rest[0]), int(rest[1]), float(rest[2])))
