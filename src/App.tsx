import React, { useEffect, useMemo, useRef, useState } from "react";

type Segment = {
  id: number;
  blob: Blob;
  url: string;
};

type OutputVideo = {
  label: string;
  blob: Blob;
  url: string;
  mime: string;
};

type WorkerMsg =
  | { type: "loaded" }
  | { type: "progress"; message: string }
  | {
      type: "result";
      outputName: string;
      mimeType: string;
      data: ArrayBuffer;
      runId?: string;
      phase?: string;
    }
  | { type: "error"; message: string; runId?: string; phase?: string };

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return await blob.arrayBuffer();
}

function nowIso() {
  return new Date().toISOString();
}

function mkRunId() {
  const a = Date.now().toString();
  const b = Math.random().toString(16).slice(2);
  return `${a}-${b}`;
}

type RunResult = {
  timestamp: string;
  runId: string;

  segmentCount: number;
  segmentDurationMs: number;
  gapMs: number;

  segmentSizesBytes: number[];
  mergedBytes: number;
  mp4Bytes: number;

  tRecordMs: number;
  tMergeMs: number;
  tMp4Ms: number;
  tTotalMs: number;
};

async function appendToFile(fileHandle: FileSystemFileHandle, text: string) {
  const writable = await fileHandle.createWritable({ keepExistingData: true });
  await writable.seek((await fileHandle.getFile()).size);
  await writable.write(text);
  await writable.close();
}

export default function App() {
  const videoPreviewRef = useRef<HTMLVideoElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<BlobPart[]>([]);

  const [segments, setSegments] = useState<Segment[]>([]);
  const [isRecording, setIsRecording] = useState(false);

  const [logs, setLogs] = useState<string>("");
  const [rawMerged, setRawMerged] = useState<OutputVideo | null>(null);
  const [mp4, setMp4] = useState<OutputVideo | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const [workerLoaded, setWorkerLoaded] = useState(false);

  const [isBusy, setIsBusy] = useState(false);

  // Automated run settings (you can expose in UI later if needed)
  const [segmentCount] = useState(4);
  const [segmentDurationMs] = useState(5000);
  const [gapMs] = useState(250);

  // File logging (optional)
  const fileHandleRef = useRef<FileSystemFileHandle | null>(null);
  const [logFileName, setLogFileName] = useState<string>("(none)");

  // Pending promises for worker results
  const pendingRef = useRef<
    Record<
      string,
      {
        resolve: (x: { blob: Blob; mime: string; bytes: number }) => void;
        reject: (e: Error) => void;
      }
    >
  >({});

  function uiLog(line: string) {
    const msg = `${nowIso()} ${line}`;
    setLogs((prev) => {
      const next = prev + msg + "\n";
      const lines = next.split("\n");
      return lines.length > 350
        ? lines.slice(lines.length - 350).join("\n")
        : next;
    });
  }

  useEffect(() => {
    const w = new Worker(
      new URL("./workers/ffmpeg.worker.ts", import.meta.url),
      { type: "module" }
    );
    workerRef.current = w;

    w.onmessage = (e: MessageEvent<WorkerMsg>) => {
      const msg = e.data;

      if (msg.type === "loaded") {
        setWorkerLoaded(true);
        uiLog("[Worker] FFmpeg loaded.");
        return;
      }

      if (msg.type === "progress") {
        // Keep worker logs in the UI log pane (bounded)
        setLogs((prev) => {
          const next = prev + msg.message + "\n";
          const lines = next.split("\n");
          return lines.length > 350
            ? lines.slice(lines.length - 350).join("\n")
            : next;
        });
        return;
      }

      if (msg.type === "error") {
        const key = `${msg.runId ?? "no-run"}:${msg.phase ?? "no-phase"}`;
        const pending = pendingRef.current[key];
        if (pending) {
          delete pendingRef.current[key];
          pending.reject(new Error(msg.message));
        }
        uiLog(
          `[ERROR]${
            msg.runId
              ? ` (${msg.runId}${msg.phase ? `-${msg.phase}` : ""})`
              : ""
          } ${msg.message}`
        );
        return;
      }

      if (msg.type === "result") {
        const blob = new Blob([msg.data], { type: msg.mimeType });
        const bytes = blob.size;

        const key = `${msg.runId ?? "no-run"}:${msg.phase ?? "no-phase"}`;
        const pending = pendingRef.current[key];
        if (pending) {
          delete pendingRef.current[key];
          pending.resolve({ blob, mime: msg.mimeType, bytes });
        } else {
          // Non-automated legacy handling: set outputs for preview
          const url = URL.createObjectURL(blob);
          if (msg.outputName === "merged.webm") {
            setRawMerged({
              label: "Raw merged (stream copy)",
              blob,
              url,
              mime: msg.mimeType,
            });
          } else if (msg.outputName === "reencoded.mp4") {
            setMp4({
              label: "Re-encoded MP4 (H.264)",
              blob,
              url,
              mime: msg.mimeType,
            });
          }
        }
        return;
      }
    };

    w.postMessage({ type: "load" });

    return () => {
      w.terminate();
      workerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ensureCamera() {
    if (mediaStreamRef.current) return mediaStreamRef.current;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "user" },
    });

    mediaStreamRef.current = stream;

    if (videoPreviewRef.current) {
      videoPreviewRef.current.srcObject = stream;
      await videoPreviewRef.current.play().catch(() => void 0);
    }

    return stream;
  }

  function stopCamera() {
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
    if (videoPreviewRef.current) videoPreviewRef.current.srcObject = null;
  }

  function clearAll() {
    for (const s of segments) URL.revokeObjectURL(s.url);
    if (rawMerged) URL.revokeObjectURL(rawMerged.url);
    if (mp4) URL.revokeObjectURL(mp4.url);

    setSegments([]);
    setRawMerged(null);
    setMp4(null);
    setLogs("");
  }

  const totalSegmentBytes = useMemo(
    () => segments.reduce((sum, s) => sum + s.blob.size, 0),
    [segments]
  );

  async function recordOneSegment(durationMs: number): Promise<Blob> {
    const stream = await ensureCamera();

    const candidates = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ];
    const mimeType =
      candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";

    return await new Promise<Blob>((resolve, reject) => {
      try {
        const mr = new MediaRecorder(
          stream,
          mimeType ? { mimeType } : undefined
        );
        mediaRecorderRef.current = mr;
        recordedChunksRef.current = [];

        mr.ondataavailable = (ev) => {
          if (ev.data && ev.data.size > 0)
            recordedChunksRef.current.push(ev.data);
        };

        mr.onstop = () => {
          const blob = new Blob(recordedChunksRef.current, {
            type: mr.mimeType || "video/webm",
          });
          recordedChunksRef.current = [];
          resolve(blob);
        };

        mr.onerror = (e) => reject(e);

        mr.start();
        setIsRecording(true);

        setTimeout(() => {
          try {
            if (mr.state === "recording") mr.stop();
            setIsRecording(false);
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        }, durationMs);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  async function workerConcat(
    runId: string,
    segBlobs: Blob[]
  ): Promise<{ blob: Blob; bytes: number; mime: string }> {
    if (!workerRef.current || !workerLoaded)
      throw new Error("FFmpeg worker not loaded.");

    const segmentInputs = await Promise.all(
      segBlobs.map(async (b, idx) => {
        const ab = await blobToArrayBuffer(b);
        return { name: `seg${idx}.webm`, data: ab };
      })
    );

    const transfer: Transferable[] = segmentInputs.map((x) => x.data);

    const key = `${runId}:merge`;
    const p = new Promise<{ blob: Blob; bytes: number; mime: string }>(
      (resolve, reject) => {
        pendingRef.current[key] = { resolve, reject };
      }
    );

    workerRef.current.postMessage(
      {
        type: "concat",
        segments: segmentInputs,
        outputName: "merged.webm",
        runId,
        phase: "merge",
      },
      transfer
    );

    return await p;
  }

  async function workerReencodeMp4(
    runId: string,
    mergedBlob: Blob
  ): Promise<{ blob: Blob; bytes: number; mime: string }> {
    if (!workerRef.current || !workerLoaded)
      throw new Error("FFmpeg worker not loaded.");

    const inputData = await blobToArrayBuffer(mergedBlob);

    // Stable settings: generate timestamps, force CFR, 30fps
    const mp4Args = [
      "-fflags",
      "+genpts",
      "-fps_mode",
      "cfr",
      "-r",
      "30",
      "-vf",
      "fps=30",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "28",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-an",
    ];

    const key = `${runId}:mp4`;
    const p = new Promise<{ blob: Blob; bytes: number; mime: string }>(
      (resolve, reject) => {
        pendingRef.current[key] = { resolve, reject };
      }
    );

    workerRef.current.postMessage(
      {
        type: "reencode",
        inputName: "merged.webm",
        inputData,
        outputName: "reencoded.mp4",
        args: mp4Args,
        runId,
        phase: "mp4",
      },
      [inputData]
    );

    return await p;
  }

  async function pickLogFile() {
    if (!("showSaveFilePicker" in window)) {
      uiLog(
        "[ERROR] File System Access API not supported in this browser. Use Chrome/Edge."
      );
      return;
    }

    const handle = await (window as any).showSaveFilePicker({
      suggestedName: "video-reencode-log.jsonl",
      types: [
        {
          description: "JSONL log file",
          accept: { "text/plain": [".jsonl", ".txt"] },
        },
      ],
    });

    fileHandleRef.current = handle;
    setLogFileName(handle?.name ?? "(selected)");
    uiLog("[INFO] Log file selected. Results will be appended.");

    // If file is empty, write header
    try {
      const f = await handle.getFile();
      if (f.size === 0) {
        await appendToFile(
          handle,
          "# Video re-encode test log (JSONL)\n# Each line is a JSON object\n"
        );
      }
    } catch (e) {
      uiLog(`[ERROR] Failed to initialize log file: ${String(e)}`);
    }
  }

  async function runAutomated() {
    if (isBusy) return;
    if (!workerLoaded) {
      uiLog("[ERROR] FFmpeg worker is not loaded yet.");
      return;
    }

    setIsBusy(true);
    clearAll();

    const runId = mkRunId();
    const startTotal = performance.now();

    uiLog(
      `[RUN ${runId}] Starting automated test. segmentCount=${segmentCount}, segmentDurationMs=${segmentDurationMs}, gapMs=${gapMs}`
    );

    const startRecord = performance.now();
    const segBlobs: Blob[] = [];
    const segSizes: number[] = [];
    const segUrls: string[] = [];

    try {
      for (let i = 0; i < segmentCount; i++) {
        uiLog(
          `[RUN ${runId}] Recording segment ${
            i + 1
          }/${segmentCount} for ${segmentDurationMs}ms...`
        );
        const b = await recordOneSegment(segmentDurationMs);
        segBlobs.push(b);
        segSizes.push(b.size);

        const url = URL.createObjectURL(b);
        segUrls.push(url);

        uiLog(
          `[RUN ${runId}] Segment ${i + 1} size: ${b.size} bytes (${formatBytes(
            b.size
          )})`
        );

        if (i < segmentCount - 1) {
          await sleep(gapMs);
        }
      }
    } catch (e) {
      uiLog(`[RUN ${runId}] Recording failed: ${String(e)}`);
      setIsBusy(false);
      return;
    } finally {
      setIsRecording(false);
    }

    const tRecordMs = Math.round(performance.now() - startRecord);

    // Update UI segments list for preview
    setSegments(
      segBlobs.map((b, idx) => ({ id: idx + 1, blob: b, url: segUrls[idx] }))
    );

    // Merge
    const startMerge = performance.now();
    let merged: { blob: Blob; bytes: number; mime: string };
    try {
      merged = await workerConcat(runId, segBlobs);
    } catch (e) {
      uiLog(`[RUN ${runId}] Merge failed: ${String(e)}`);
      setIsBusy(false);
      return;
    }
    const tMergeMs = Math.round(performance.now() - startMerge);

    uiLog(
      `[RUN ${runId}] Merged size: ${merged.bytes} bytes (${formatBytes(
        merged.bytes
      )}) in ${tMergeMs}ms`
    );

    const mergedUrl = URL.createObjectURL(merged.blob);
    setRawMerged({
      label: "Merged (stream copy)",
      blob: merged.blob,
      url: mergedUrl,
      mime: merged.mime,
    });

    // MP4 re-encode
    const startMp4 = performance.now();
    let mp4Out: { blob: Blob; bytes: number; mime: string };
    try {
      uiLog(`[RUN ${runId}] Re-encoding MP4 (H.264/libx264)...`);
      mp4Out = await workerReencodeMp4(runId, merged.blob);
    } catch (e) {
      uiLog(`[RUN ${runId}] MP4 encode failed: ${String(e)}`);
      setIsBusy(false);
      return;
    }
    const tMp4Ms = Math.round(performance.now() - startMp4);

    uiLog(
      `[RUN ${runId}] MP4 size: ${mp4Out.bytes} bytes (${formatBytes(
        mp4Out.bytes
      )}) in ${tMp4Ms}ms`
    );

    const mp4Url = URL.createObjectURL(mp4Out.blob);
    setMp4({
      label: "Re-encoded MP4 (H.264)",
      blob: mp4Out.blob,
      url: mp4Url,
      mime: mp4Out.mime,
    });

    const tTotalMs = Math.round(performance.now() - startTotal);

    const result: RunResult = {
      timestamp: nowIso(),
      runId,
      segmentCount,
      segmentDurationMs,
      gapMs,
      segmentSizesBytes: segSizes,
      mergedBytes: merged.bytes,
      mp4Bytes: mp4Out.bytes,
      tRecordMs,
      tMergeMs,
      tMp4Ms,
      tTotalMs,
    };

    uiLog(`[RUN ${runId}] Done. Total time: ${tTotalMs}ms`);

    // Append JSONL entry if user selected a log file
    try {
      const handle = fileHandleRef.current;
      if (handle) {
        await appendToFile(handle, JSON.stringify(result) + "\n");
        uiLog(`[RUN ${runId}] Appended results to log file: ${logFileName}`);
      } else {
        uiLog(`[RUN ${runId}] No log file selected; skipping file append.`);
      }
    } catch (e) {
      uiLog(`[ERROR] Failed to append to log file: ${String(e)}`);
    }

    setIsBusy(false);
  }

  const reduction = useMemo(() => {
    if (!rawMerged || !mp4) return null;
    const a = rawMerged.blob.size;
    const b = mp4.blob.size;
    const pct = a === 0 ? 0 : ((a - b) / a) * 100;
    return { a, b, pct };
  }, [rawMerged, mp4]);

  return (
    <div className="container">
      <h1>Video Merge + Re-encode Size Test (Auto, MP4 only)</h1>
      <p className="small">
        Automatically records 4 segments (~20s), merges them, then re-encodes to
        H.264 MP4 and logs size/time metrics. VP9 has been removed entirely for
        stability.
      </p>

      <div className="card">
        <h2>0) Log File (optional)</h2>
        <div className="row">
          <button
            className="secondary"
            onClick={() =>
              pickLogFile().catch((e) => uiLog(`[ERROR] ${String(e)}`))
            }
          >
            Select Log File (append JSONL)
          </button>
          <div className="small">Selected: {logFileName}</div>
        </div>
        <div className="small" style={{ marginTop: 8 }}>
          Requires Chrome/Edge (File System Access API). If not selected,
          results stay in the UI log.
        </div>
      </div>

      <div className="card">
        <h2>1) Camera Preview</h2>
        <video ref={videoPreviewRef} playsInline muted />
        <div className="row" style={{ marginTop: 12 }}>
          <button
            onClick={() =>
              ensureCamera().catch((e) =>
                uiLog(`[ERROR] Camera error: ${String(e)}`)
              )
            }
            className="secondary"
          >
            Start Camera
          </button>
          <button onClick={stopCamera} className="secondary">
            Stop Camera
          </button>
        </div>
      </div>

      <div className="card">
        <h2>2) Automated Run</h2>
        <div className="row">
          <button
            disabled={!workerLoaded || isBusy}
            onClick={() =>
              runAutomated().catch((e) => uiLog(`[ERROR] ${String(e)}`))
            }
          >
            Run Auto Test (4 segments → merge → MP4)
          </button>
          <button disabled={isBusy} className="danger" onClick={clearAll}>
            Clear
          </button>
        </div>

        <div className="kv">
          <div className="small">Worker loaded</div>
          <div className="small">{String(workerLoaded)}</div>

          <div className="small">Recording</div>
          <div className="small">{String(isRecording)}</div>

          <div className="small">Segments recorded</div>
          <div className="small">{segments.length}</div>

          <div className="small">Total segment bytes</div>
          <div className="small">{formatBytes(totalSegmentBytes)}</div>
        </div>
      </div>

      {segments.length > 0 && (
        <div className="card">
          <h2>3) Segments</h2>
          {segments.map((s) => (
            <div key={s.id} className="card" style={{ background: "#101225" }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <div>
                    <strong>Segment {s.id}</strong>
                  </div>
                  <div className="small">
                    Size: {formatBytes(s.blob.size)} | MIME:{" "}
                    {s.blob.type || "unknown"}
                  </div>
                </div>
                <a
                  className="small"
                  href={s.url}
                  download={`segment-${s.id}.webm`}
                >
                  Download
                </a>
              </div>
              <video src={s.url} controls />
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h2>4) Outputs</h2>

        {rawMerged && (
          <>
            <h3>Merged (stream copy)</h3>
            <div className="small">
              Size: {formatBytes(rawMerged.blob.size)} | MIME: {rawMerged.mime}
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <a className="small" href={rawMerged.url} download="merged.webm">
                Download merged.webm
              </a>
            </div>
            <video src={rawMerged.url} controls />
          </>
        )}

        {mp4 && (
          <>
            <hr />
            <h3>Re-encoded MP4 (H.264)</h3>
            <div className="small">
              Size: {formatBytes(mp4.blob.size)} | MIME: {mp4.mime}
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <a className="small" href={mp4.url} download="reencoded.mp4">
                Download reencoded.mp4
              </a>
            </div>
            <video src={mp4.url} controls />
          </>
        )}

        {reduction && (
          <>
            <hr />
            <h3>Size difference</h3>
            <div className="kv">
              <div className="small">Merged</div>
              <div className="small">{formatBytes(reduction.a)}</div>
              <div className="small">MP4</div>
              <div className="small">{formatBytes(reduction.b)}</div>
              <div className="small">Reduction</div>
              <div className="small">{reduction.pct.toFixed(2)}%</div>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h2>Logs</h2>
        <div className="mono">{logs || "(no logs yet)"}</div>
      </div>
    </div>
  );
}
