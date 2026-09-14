/// <reference lib="webworker" />
// On-device Whisper transcription. Runs off the main thread. Receives decoded
// 16 kHz mono PCM and posts back { answerId, transcript } or { answerId, error }.
// Model weights are fetched once from Hugging Face and cached by the library;
// the audio itself never leaves the device.
import { pipeline, env } from "@xenova/transformers";

// The Whisper model. A module constant so it can be tuned later. There is no
// settings surface for it (out of scope this EPIC).
const MODEL_ID = "Xenova/whisper-base.en";

// Serve the ONNX wasm backend from our own bundle ('self' under CSP), not a
// third-party CDN. The .wasm files are copied to /ort/ at build time.
env.backends.onnx.wasm.wasmPaths = "/ort/";
// Weights come from the Hugging Face hub (public model files), then cache.
env.allowLocalModels = false;

type Transcriber = (
  audio: Float32Array,
  opts?: Record<string, unknown>
) => Promise<{ text: string } | { text: string }[]>;

let transcriberPromise: Promise<Transcriber> | null = null;

function getTranscriber(): Promise<Transcriber> {
  if (!transcriberPromise) {
    transcriberPromise = pipeline(
      "automatic-speech-recognition",
      MODEL_ID
    ) as unknown as Promise<Transcriber>;
  }
  return transcriberPromise;
}

self.onmessage = async (e: MessageEvent) => {
  const { answerId, audio } = e.data as { answerId: string; audio: Float32Array };
  try {
    const transcriber = await getTranscriber();
    const result = await transcriber(audio);
    const text = Array.isArray(result) ? result[0]?.text : result.text;
    (self as unknown as Worker).postMessage({
      answerId,
      transcript: (text ?? "").trim(),
    });
  } catch (err) {
    (self as unknown as Worker).postMessage({
      answerId,
      error: err instanceof Error ? err.message : "transcription failed",
    });
  }
};
