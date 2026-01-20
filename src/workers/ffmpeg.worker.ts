/// <reference lib="webworker" />

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";

type SegmentInput = {
  name: string;
  data: ArrayBuffer;
};

type LoadRequest = { type: "load" };

type ConcatRequest = {
  type: "concat";
  segments: SegmentInput[];
  outputName: string; // merged.webm
  runId?: string;
  phase?: string; // "merge"
};

type ReencodeRequest = {
  type: "reencode";
  inputName: string; // merged.webm
  inputData: ArrayBuffer;
  outputName: string; // reencoded.mp4
  args: string[];
  runId?: string;
  phase?: string; // "mp4"
};

type WorkerRequest = LoadRequest | ConcatRequest | ReencodeRequest;

type WorkerResponse =
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

const ffmpeg = new FFmpeg();
let loaded = false;

function post(msg: WorkerResponse, transfer?: Transferable[]) {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(
    msg,
    transfer ?? []
  );
}

async function ensureLoaded() {
  if (loaded) return;

  const coreBase = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";

  ffmpeg.on("log", ({ message }) => {
    post({ type: "progress", message });
  });

  const coreURL = await toBlobURL(
    `${coreBase}/ffmpeg-core.js`,
    "text/javascript"
  );
  const wasmURL = await toBlobURL(
    `${coreBase}/ffmpeg-core.wasm`,
    "application/wasm"
  );

  try {
    const workerURL = await toBlobURL(
      `${coreBase}/ffmpeg-core.worker.js`,
      "text/javascript"
    );
    await ffmpeg.load({ coreURL, wasmURL, workerURL });
  } catch {
    await ffmpeg.load({ coreURL, wasmURL });
  }

  loaded = true;
  post({ type: "loaded" });
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  try {
    const req = event.data;

    if (req.type === "load") {
      await ensureLoaded();
      return;
    }

    await ensureLoaded();

    if (req.type === "concat") {
      for (const seg of req.segments) {
        await ffmpeg.writeFile(seg.name, new Uint8Array(seg.data));
      }

      const list = req.segments.map((s) => `file '${s.name}'`).join("\n");
      await ffmpeg.writeFile("list.txt", new TextEncoder().encode(list));

      // Stream copy concat (fast). Note: input timebase may show as 1k; MP4 encode step normalizes CFR.
      await ffmpeg.exec([
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        "list.txt",
        "-c",
        "copy",
        req.outputName,
      ]);

      const out = await ffmpeg.readFile(req.outputName);
      const outBuf = new Uint8Array(out as Uint8Array).buffer;

      await ffmpeg.deleteFile("list.txt");
      for (const seg of req.segments) await ffmpeg.deleteFile(seg.name);
      await ffmpeg.deleteFile(req.outputName);

      post(
        {
          type: "result",
          outputName: req.outputName,
          mimeType: "video/webm",
          data: outBuf,
          runId: req.runId,
          phase: req.phase,
        },
        [outBuf]
      );
      return;
    }

    if (req.type === "reencode") {
      await ffmpeg.writeFile(req.inputName, new Uint8Array(req.inputData));

      await ffmpeg.exec(["-i", req.inputName, ...req.args, req.outputName]);

      const out = await ffmpeg.readFile(req.outputName);
      const outBuf = new Uint8Array(out as Uint8Array).buffer;

      await ffmpeg.deleteFile(req.inputName);
      await ffmpeg.deleteFile(req.outputName);

      const mimeType = req.outputName.endsWith(".mp4")
        ? "video/mp4"
        : "application/octet-stream";

      post(
        {
          type: "result",
          outputName: req.outputName,
          mimeType,
          data: outBuf,
          runId: req.runId,
          phase: req.phase,
        },
        [outBuf]
      );
      return;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const req = event.data as any;
    post({ type: "error", message, runId: req?.runId, phase: req?.phase });
  }
};
