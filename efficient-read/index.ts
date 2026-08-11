import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition, type ReadToolDetails } from "@earendil-works/pi-coding-agent";
import { createReadStream } from "node:fs";
import { access, open, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Type } from "typebox";

// Keep these deliberately below a typical model's useful context budget.
const MAX_LINES = 2_000;
const MAX_BYTES = 50 * 1024;
const MAX_CHARS_PER_LINE = 2_000;
const RESERVED_NOTICE_BYTES = 512;
const BLOCKED_DEVICE_PATH = /^(?:\/dev\/(?:zero|urandom|random|stdin|stdout|stderr)|\/proc\/\d+\/fd(?:\/|$))/;
const IMAGE_MAGIC: Array<[string, (bytes: Buffer) => boolean]> = [
  ["image/png", b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["image/jpeg", b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/gif", b => b.subarray(0, 6).toString() === "GIF87a" || b.subarray(0, 6).toString() === "GIF89a"],
  ["image/webp", b => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP"],
  ["image/bmp", b => b[0] === 0x42 && b[1] === 0x4d],
];

// Read-window dedup: re-reading the same unchanged window returns a short
// note instead of re-serving content (a one-shot "unchanged" hint, then a
// nag on the 3rd+ identical read).
const REPEAT_THRESHOLD = 3;
interface WindowKey { mtimeMs: number; size: number; offset: number; limit: number }
const lastWindow = new Map<string, WindowKey>();
const repeatCount = new Map<string, { count: number; window: WindowKey }>();

const schema = Type.Object({
  path: Type.String({ description: "Path to a text file or image (relative or absolute)" }),
  offset: Type.Optional(Type.Integer({ minimum: -1_000_000, description: "1-indexed line at which to start. NEGATIVE reads from the end: offset=-50 returns the last 50 lines; offset=-50 with limit=10 returns the first 10 of those last 50. Use it to inspect a log tail without a length-finding read first." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LINES, description: `Lines to return (maximum ${MAX_LINES}). With a negative offset, limit is the window within the tail.` })),
});

type Params = { path: string; offset?: number; limit?: number };

function byteLength(text: string) { return Buffer.byteLength(text, "utf8"); }
function displayPath(path: string, cwd: string) { const r = relative(cwd, path); return r && !r.startsWith("..") ? r : path; }
function normalizeInputPath(path: string) {
  let value = path.trim().replace(/^@/, "").replace(/\u202f/g, " ");
  if (value === "~") value = homedir();
  else if (value.startsWith("~/")) value = resolve(homedir(), value.slice(2));
  return value;
}
function candidatePaths(path: string) {
  const nfd = path.normalize("NFD");
  const nfc = path.normalize("NFC");
  const curly = path.replace(/'/g, "\u2019");
  const straight = path.replace(/\u2019/g, "'");
  const narrow = path.replace(/ /g, "\u202f");
  const normal = path.replace(/\u202f/g, " ");
  return [...new Set([path, nfd, nfc, curly, straight, nfd.replace(/'/g, "\u2019"), nfc.replace(/'/g, "\u2019"), narrow, normal])];
}
async function resolveExistingPath(raw: string, cwd: string) {
  const input = normalizeInputPath(raw);
  const initial = isAbsolute(input) ? resolve(input) : resolve(cwd, input);
  for (const candidate of candidatePaths(initial)) {
    try { await access(candidate, constants.F_OK); return candidate; } catch { /* try repair */ }
  }
  return initial;
}
function levenshteinAtMostTwo(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 2) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i]; let min = current[0];
    for (let j = 1; j <= b.length; j++) { const v = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); current.push(v); min = Math.min(min, v); }
    if (min > 2) return false;
    previous = current;
  }
  return previous[b.length] <= 2;
}
async function suggestion(path: string, cwd: string) {
  try {
    const target = basename(path).toLowerCase();
    const names = await readdir(dirname(path));
    const match = names.find(n => n.toLowerCase().includes(target) || target.includes(n.toLowerCase()))
      ?? names.find(n => levenshteinAtMostTwo(target, n.toLowerCase()));
    return match ? ` Did you mean: ${displayPath(resolve(dirname(path), match), cwd)}?` : "";
  } catch { return ""; }
}
async function sniff(path: string) {
  const handle = await open(path, "r");
  try { const bytes = Buffer.alloc(512); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0); return bytes.subarray(0, bytesRead); }
  finally { await handle.close(); }
}
function clamp(fragment: string, remaining: number) {
  if (remaining <= 0) return "";
  const points = Array.from(fragment);
  return points.length <= remaining ? fragment : points.slice(0, remaining).join("");
}

/* ------------------------------------------------------------------ *
 * Tail read: negative offset. Stream the file once, keep a byte-accounted
 * ring buffer of the last N lines, return the requested window of them.
 * ------------------------------------------------------------------ */

interface TailResult {
  content: string;   // rendered "firstLine: text" lines
  firstLine: number; // 1-indexed line number of the first rendered line
  totalLines: number;
  empty: boolean;
  byteCut: boolean;
}

async function readTail(opts: {
  path: string;
  tailLines: number;    // |offset| — how many trailing lines to retain
  windowLines: number;  // limit — how many of those to return
  maxLineLength: number;
  maxBytes: number;
  signal?: AbortSignal;
}): Promise<TailResult> {
  const { path, tailLines, windowLines, maxLineLength, maxBytes, signal } = opts;
  const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
  const decoder = new StringDecoder("utf8");
  const retained: string[] = [];
  let retainedBytes = 0;
  let lineNo = 0;
  let byteCut = false;
  let current = "";

  const pushLine = (raw: string) => {
    let line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (maxLineLength && Array.from(line).length > maxLineLength) {
      line = Array.from(line).slice(0, maxLineLength).join("") + " … [line truncated]";
    }
    lineNo += 1;
    retained.push(line);
    retainedBytes += byteLength(line) + 1;
    if (retained.length > tailLines) {
      const old = retained.shift()!;
      retainedBytes -= byteLength(old) + 1;
    }
    while (retained.length > 1 && retainedBytes > maxBytes) {
      const old = retained.shift()!;
      retainedBytes -= byteLength(old) + 1;
      byteCut = true;
    }
  };

  try {
    for await (const chunk of stream) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const text = decoder.write(chunk as Buffer);
      let start = 0;
      let nl: number;
      while ((nl = text.indexOf("\n", start)) !== -1) {
        current += text.slice(start, nl);
        pushLine(current);
        current = "";
        start = nl + 1;
      }
      current += text.slice(start);
    }
    const tail = decoder.end();
    if (tail) current += tail;
    if (current !== "") pushLine(current);
  } finally {
    if (!stream.destroyed) stream.destroy();
  }

  if (lineNo === 0) return { content: "", firstLine: 1, totalLines: 0, empty: true, byteCut: false };
  const window = retained.slice(0, windowLines);
  const firstLine = Math.max(1, lineNo - retained.length + 1);
  const content = window.map((line, i) => `${firstLine + i}: ${line}`).join("\n");
  return { content, firstLine, totalLines: lineNo, empty: false, byteCut };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "read",
    label: "read",
    description: `Stream a text file with 1-indexed line numbers. Results are capped at ${MAX_LINES} lines, ${MAX_BYTES / 1024}KB, and ${MAX_CHARS_PER_LINE} characters per line; use the supplied offset to continue. A negative offset reads from the end (offset=-50 returns the last 50 lines). Re-reading the same unchanged window returns a short "unchanged" note instead of re-serving content. Images attach normally.`,
    promptSnippet: "Read bounded, numbered file contents",
    promptGuidelines: ["Use read to examine files instead of cat or sed. Follow its supplied offset exactly when continuing a truncated read. For log tails use a negative offset (offset=-50) instead of reading the whole file."],
    parameters: schema,
    prepareArguments(args: unknown) {
      if (!args || typeof args !== "object") return args as unknown as Params;
      const input = args as Record<string, unknown>;
      const path = input.path ?? input.file_path ?? input.filePath ?? input.absolutePath ?? input.target_file;
      const coerce = (v: unknown) => typeof v === "string" && v.trim() !== "" ? Number(v) : v;
      return { ...input, path, offset: coerce(input.offset), limit: coerce(input.limit) } as unknown as Params;
    },
    async execute(id, params: Params, signal, update, ctx) {
      const path = await resolveExistingPath(params.path, ctx.cwd);
      if (BLOCKED_DEVICE_PATH.test(path)) return { content: [{ type: "text", text: `Note: refusing special device path ${params.path}; it may never reach EOF.` }], details: {} };
      let info;
      try { info = await stat(path); await access(path, constants.R_OK); } catch {
        return { content: [{ type: "text", text: `Note: ${params.path} was not found or is not readable.${await suggestion(path, ctx.cwd)}` }], details: {} };
      }
      if (!info.isFile()) return { content: [{ type: "text", text: `Note: ${params.path} is not a regular file.` }], details: {} };
      const sample = await sniff(path);
      const image = IMAGE_MAGIC.find(([, test]) => test(sample));
      if (image) return createReadToolDefinition(ctx.cwd).execute(id, params, signal, update, ctx);
      if (sample.includes(0)) return { content: [{ type: "text", text: `Note: ${params.path} appears to be binary (${info.size} bytes); it was not sent as text.` }], details: {} };
      if (sample.subarray(0, 5).toString() === "%PDF-") return { content: [{ type: "text", text: `Note: ${params.path} is a PDF. Use pdftotext or a PDF-specific tool rather than reading binary bytes.` }], details: {} };

      const rawOffset = params.offset ?? 1;
      const lineLimit = params.limit ?? MAX_LINES;
      const isTail = rawOffset < 0;
      const start = isTail ? 1 : Math.max(1, Math.trunc(rawOffset));

      // --- read-window dedup + repeated-read nag (text reads only) ---
      // Two mechanisms, mirroring the read-tool engineering article:
      //   (a) one-shot dedup: the 2nd identical read of an unchanged window
      //       returns a short "unchanged" note (and forgets the window, so
      //       the NEXT read serves content again).
      //   (b) repeated-read nag: on the 3rd+ actual read of the same
      //       unchanged window, append a nag telling the model to stop
      //       re-reading and continue its task.
      const win: WindowKey = { mtimeMs: info.mtimeMs, size: info.size, offset: isTail ? rawOffset : start, limit: lineLimit };
      const keysEqual = (a: WindowKey) => a.mtimeMs === win.mtimeMs && a.size === win.size && a.offset === win.offset && a.limit === win.limit;
      const prevWindow = lastWindow.get(path);
      if (prevWindow && keysEqual(prevWindow)) {
        lastWindow.delete(path); // one-shot
        return {
          content: [{ type: "text", text: `Note: ${displayPath(path, ctx.cwd)} is unchanged since the last identical read — the earlier content is still current. Continue with your task instead of re-reading.` }],
          details: {} as ReadToolDetails,
        };
      }
      lastWindow.set(path, win);
      let nag = "";
      const prevRepeat = repeatCount.get(path);
      const n = prevRepeat && keysEqual(prevRepeat.window) ? prevRepeat.count + 1 : 1;
      repeatCount.set(path, { count: n, window: win });
      if (n >= REPEAT_THRESHOLD) {
        repeatCount.delete(path);
        nag = `Note: this is read ${n} of the same unchanged window in this session. If you still have that content, continue with your task instead of re-reading it.`;
      }

      // --- tail path: negative offset ---
      if (isTail) {
        const tail = await readTail({
          path,
          tailLines: Math.min(Math.abs(rawOffset), 1_000_000),
          windowLines: lineLimit,
          maxLineLength: MAX_CHARS_PER_LINE,
          maxBytes: MAX_BYTES - RESERVED_NOTICE_BYTES,
          signal,
        });
        if (tail.empty) {
          return { content: [{ type: "text", text: `Note: ${params.path} is empty.` }], details: {} as ReadToolDetails };
        }
        let text = tail.content;
        if (tail.byteCut) {
          text += `\n\n[Byte limit reached in tail read. The last ${tail.totalLines > 0 ? "lines within the window" : "lines"} are shown; use grep to search the rest.]`;
        }
        if (nag) text += `\n\n${nag}`;
        return { content: [{ type: "text", text }], details: {} as ReadToolDetails };
      }

      // --- forward path ---
      const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
      const decoder = new StringDecoder("utf8");
      let line = 1, selected = 0, outputBytes = 0, lineChars = 0, captured = "", clamped = false, stop = false, byteCut = false, lineCut = false, pendingLineLimit = false, ended = false;
      const rendered: string[] = [];
      const flushLine = () => {
        if (line >= start && !stop) {
          const suffix = clamped ? " … [line truncated]" : "";
          const renderedLine = `${line}: ${captured.replace(/\r$/, "")}${suffix}`;
          if (outputBytes + byteLength(renderedLine) + 1 > MAX_BYTES - RESERVED_NOTICE_BYTES) { byteCut = true; stop = true; return; }
          rendered.push(renderedLine); outputBytes += byteLength(renderedLine) + 1; selected++;
          if (selected >= lineLimit) { lineCut = true; pendingLineLimit = true; }
        }
        line++; lineChars = 0; captured = ""; clamped = false;
      };
      try {
        for await (const chunk of stream) {
          if (signal?.aborted) throw new Error("Operation aborted");
          const text = decoder.write(chunk as Buffer);
          let cursor = 0;
          while (cursor < text.length) {
            // At an exact chunk boundary we cannot know whether EOF follows the
            // requested window. Peek only until the next decoded character.
            if (pendingLineLimit) { stop = true; break; }
            const newline = text.indexOf("\n", cursor);
            const part = newline === -1 ? text.slice(cursor) : text.slice(cursor, newline);
            if (line >= start && !stop && !clamped) captured += clamp(part, MAX_CHARS_PER_LINE - lineChars);
            lineChars += Array.from(part).length;
            if (lineChars > MAX_CHARS_PER_LINE) clamped = true;
            if (newline === -1) break;
            flushLine(); cursor = newline + 1;
          }
          if (stop) { stream.destroy(); break; }
        }
        const tail = decoder.end();
        if (tail && !stop) { if (line >= start && !clamped) captured += clamp(tail, MAX_CHARS_PER_LINE - lineChars); lineChars += Array.from(tail).length; if (lineChars > MAX_CHARS_PER_LINE) clamped = true; }
        if (!stop && (captured !== "" || lineChars > 0)) flushLine();
        ended = !stop;
      } finally { if (!stream.destroyed) stream.destroy(); }
      if (rendered.length === 0 && ended) return { content: [{ type: "text", text: line === 1 ? `Note: ${params.path} is empty.` : `Note: offset ${start} is beyond EOF (${line - 1} lines scanned). Retry with a smaller offset.` }], details: {} as ReadToolDetails };
      let text = rendered.join("\n");
      if (byteCut) text += `\n\n[Byte limit reached. Continue with offset=${line}; line ${line} was not included.]`;
      else if (lineCut && !ended) text += `\n\n[Line window reached. Continue with offset=${line}.]`;
      else if (!ended) text += `\n\n[Read stopped before EOF. Continue with offset=${line}.]`;
      if (nag) text += `\n\n${nag}`;
      return { content: [{ type: "text", text }], details: {} as ReadToolDetails };
    },
  });
}
