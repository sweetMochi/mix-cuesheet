/**
 * 音訊來源的實際實作：以 yt-dlp 下載最佳音質的音訊，再以 FFmpeg 切出片段
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { AudioSourceError, type AudioSource } from './audio-source.ts';
import type { SegmentSpec } from './segment-plan.ts';
import { FFMPEG_PATH, isMissingExecutable, runTool, ToolExitError, YT_DLP_PATH } from './tools.ts';
import { classifyYtDlpError } from './video-access.ts';
import { ytDlpCommonArgs } from './video-probe.ts';
import { watchUrl } from './youtube-url.ts';

/** 片段的取樣率；Shazam 接受 16 kHz 單聲道 */
const SEGMENT_SAMPLE_RATE = 16_000;

const AUDIO_BASENAME = 'audio';

const UPDATE_HINT = '如果問題持續，可以重新啟動 App 讓 yt-dlp 自動更新後再試';

export const ytDlpAudioSource: AudioSource = {
  async prepare(videoId, workDir, signal) {
    const args = [
      ...ytDlpCommonArgs(),
      '--format',
      'bestaudio',
      '--no-playlist',
      '--no-progress',
      '--output',
      path.join(workDir, `${AUDIO_BASENAME}.%(ext)s`),
      watchUrl(videoId),
    ];
    try {
      await runTool(YT_DLP_PATH, args, signal);
    } catch (error) {
      throw toDownloadError(error);
    }

    const audioFile = await findDownloadedAudio(workDir);
    return {
      extractSegment: (segment, segmentSignal) => extractSegment(audioFile, workDir, segment, segmentSignal),
    };
  },
};

async function findDownloadedAudio(workDir: string): Promise<string> {
  const name = (await readdir(workDir)).find(
    (file) => file.startsWith(`${AUDIO_BASENAME}.`) && !file.endsWith('.part'),
  );
  if (name === undefined) {
    throw new AudioSourceError('download-failed', `下載音訊失敗，找不到下載的檔案；${UPDATE_HINT}`);
  }
  return path.join(workDir, name);
}

function toDownloadError(error: unknown): unknown {
  if (isAbortError(error)) {
    return error;
  }
  if (isMissingExecutable(error)) {
    return new AudioSourceError('tool-missing', toolMissingMessage('yt-dlp'));
  }

  const stderr = error instanceof ToolExitError ? error.stderr : String(error);
  const access = classifyYtDlpError(stderr);
  if (access.reason === 'unknown') {
    return new AudioSourceError(
      'download-failed',
      '下載音訊失敗，請重新啟動 App 讓 yt-dlp 自動更新後再試',
      access.detail,
    );
  }
  return new AudioSourceError('download-failed', `下載音訊失敗：${access.message}；${UPDATE_HINT}`);
}

async function extractSegment(
  audioFile: string,
  workDir: string,
  segment: SegmentSpec,
  signal?: AbortSignal,
): Promise<string> {
  if (FFMPEG_PATH === null) {
    throw new AudioSourceError('tool-missing', toolMissingMessage('FFmpeg'));
  }

  const output = path.join(workDir, `segment-${segment.startSeconds}.wav`);
  const args = [
    '-v',
    'error',
    '-y',
    // 放在 -i 前面以快速定位，不需要從頭解碼
    '-ss',
    String(segment.startSeconds),
    '-t',
    String(segment.durationSeconds),
    '-i',
    audioFile,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(SEGMENT_SAMPLE_RATE),
    output,
  ];
  try {
    await runTool(FFMPEG_PATH, args, signal);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    if (isMissingExecutable(error)) {
      throw new AudioSourceError('tool-missing', toolMissingMessage('FFmpeg'));
    }
    const detail = error instanceof ToolExitError ? error.stderr.trim() || error.message : String(error);
    throw new AudioSourceError('split-failed', '切割音訊失敗', detail);
  }
  return output;
}

function toolMissingMessage(tool: string): string {
  return `找不到 ${tool} 的執行檔，請關閉後端，執行「start.ps1 -Rebuild」重新安裝依賴`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
