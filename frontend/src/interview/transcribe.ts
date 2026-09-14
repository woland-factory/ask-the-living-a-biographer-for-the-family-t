// Main-thread controller for on-device transcription. It decodes the recorded
// audio to 16 kHz mono PCM and hands it to a Web Worker so the UI thread stays
// responsive. The audio never leaves the device.
//
// Transcription is best-effort. Any failure (model cannot load, decode throws,
// inference errors) rejects here and the caller records a gentle "failed"
// state. Saving and playback are never blocked by it.

export interface TranscribeResult {
  transcript: string;
}

// Test seam: e2e sets window.__ATL_TRANSCRIBE__ to "stub" or "fail" so the
// suite can drive the success and failure paths without downloading a model.
// The hook is inert when unset (production).
function hook(): "stub" | "fail" | undefined {
  if (typeof window === "undefined") return undefined;
  return window.__ATL_TRANSCRIBE__;
}

let worker: Worker | null = null;
const pending = new Map<
  string,
  { resolve: (r: TranscribeResult) => void; reject: (e: Error) => void }
>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./transcribe.worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (e: MessageEvent) => {
    const data = e.data as { answerId: string; transcript?: string; error?: string };
    const p = pending.get(data.answerId);
    if (!p) return;
    pending.delete(data.answerId);
    if (data.error || typeof data.transcript !== "string") {
      p.reject(new Error(data.error || "transcription failed"));
    } else {
      p.resolve({ transcript: data.transcript });
    }
  };
  worker.onerror = () => {
    // A worker-level error fails every in-flight request. Callers fall back to
    // the gentle "failed" state; the recording is already safe.
    for (const [, p] of pending) p.reject(new Error("transcription failed"));
    pending.clear();
    worker = null;
  };
  return worker;
}

/** Decode a recorded Blob to a mono Float32Array at 16 kHz for Whisper. */
async function decodeTo16kMono(blob: Blob): Promise<Float32Array> {
  const AC: typeof AudioContext =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  const arrayBuf = await blob.arrayBuffer();
  const ctx = new AC();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
  } finally {
    await ctx.close();
  }
  const targetRate = 16000;
  const frames = Math.max(1, Math.ceil(decoded.duration * targetRate));
  const offline = new OfflineAudioContext(1, frames, targetRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

/**
 * Transcribe a recorded answer. Resolves with the transcript or rejects on any
 * failure. Never throws synchronously.
 */
export async function transcribe(
  answerId: string,
  blob: Blob
): Promise<TranscribeResult> {
  const h = hook();
  if (h === "fail") {
    throw new Error("transcription unavailable");
  }
  if (h === "stub") {
    return { transcript: "A short remembered story, saved with the recording." };
  }

  const audio = await decodeTo16kMono(blob);
  const w = getWorker();
  return new Promise<TranscribeResult>((resolve, reject) => {
    pending.set(answerId, { resolve, reject });
    w.postMessage({ answerId, audio }, [audio.buffer]);
  });
}
