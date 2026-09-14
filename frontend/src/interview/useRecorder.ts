import { useCallback, useEffect, useRef, useState } from "react";

// Cap a single recording at 5 minutes. The interview never rushes, but a
// runaway recording would blow the upload cap, so we auto-stop at the cap.
const MAX_MS = 5 * 60 * 1000;

export type RecorderStatus =
  | "idle"
  | "preparing"
  | "recording"
  | "recorded"
  | "denied"
  | "unsupported";

export interface Recording {
  blob: Blob;
  url: string;
  durationMs: number;
}

export interface RecorderApi {
  status: RecorderStatus;
  elapsedMs: number;
  recording: Recording | null;
  start: () => void;
  stop: () => void;
  reset: () => void;
}

export function useRecorder(): RecorderApi {
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [recording, setRecording] = useState<Recording | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const startedAtRef = useRef(0);
  const tickRef = useRef<number | null>(null);
  const capRef = useRef<number | null>(null);
  const urlRef = useRef<string | null>(null);

  const clearTimers = useCallback(() => {
    if (tickRef.current !== null) window.clearInterval(tickRef.current);
    if (capRef.current !== null) window.clearTimeout(capRef.current);
    tickRef.current = null;
    capRef.current = null;
  }, []);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
  }, []);

  const start = useCallback(() => {
    // Acknowledge the tap synchronously, before the mic resolves, so the
    // control always feels pressed within 100 ms.
    setStatus("preparing");
    setElapsedMs(0);
    setRecording((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setStatus("unsupported");
      return;
    }

    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        streamRef.current = stream;
        chunksRef.current = [];
        const rec = new MediaRecorder(stream);
        recorderRef.current = rec;

        rec.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
        };
        rec.onstop = () => {
          clearTimers();
          stopStream();
          const type = rec.mimeType || "audio/webm";
          const blob = new Blob(chunksRef.current, { type });
          const url = URL.createObjectURL(blob);
          urlRef.current = url;
          const durationMs = Math.min(MAX_MS, Date.now() - startedAtRef.current);
          setRecording({ blob, url, durationMs });
          setStatus("recorded");
        };

        startedAtRef.current = Date.now();
        rec.start();
        setStatus("recording");
        tickRef.current = window.setInterval(() => {
          setElapsedMs(Math.min(MAX_MS, Date.now() - startedAtRef.current));
        }, 200);
        capRef.current = window.setTimeout(() => stop(), MAX_MS);
      })
      .catch(() => {
        stopStream();
        setStatus("denied");
      });
  }, [clearTimers, stop, stopStream]);

  const reset = useCallback(() => {
    clearTimers();
    stopStream();
    setRecording((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
    setElapsedMs(0);
    setStatus("idle");
  }, [clearTimers, stopStream]);

  useEffect(() => {
    return () => {
      clearTimers();
      stopStream();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [clearTimers, stopStream]);

  return { status, elapsedMs, recording, start, stop, reset };
}
