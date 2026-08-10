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

const schema = Type.Object({
  path: Type.String({ description: "Path to a text file or image (relative or absolute)" }),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed line at which to start" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LINES, description: `Lines to return (maximum ${MAX_LINES})` })),
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

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "read",
    label: "read",
    description: `Stream a text file with 1-indexed line numbers. Results are capped at ${MAX_LINES} lines, ${MAX_BYTES / 1024}KB, and ${MAX_CHARS_PER_LINE} characters per line; use the supplied offset to continue. Images attach normally.`,
    promptSnippet: "Read bounded, numbered file contents",
    promptGuidelines: ["Use read to examine files instead of cat or sed. Follow its supplied offset exactly when continuing a truncated read."],
    parameters: schema,
    prepareArguments(args: unknown) {
      if (!args || typeof args !== "object") return args;
      const input = args as Record<string, unknown>;
      const path = input.path ?? input.file_path ?? input.filePath ?? input.absolutePath ?? input.target_file;
      const coerce = (v: unknown) => typeof v === "string" && v.trim() !== "" ? Number(v) : v;
      return { ...input, path, offset: coerce(input.offset), limit: coerce(input.limit) };
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

      const start = params.offset ?? 1;
      const lineLimit = params.limit ?? MAX_LINES;
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
      if (rendered.length === 0 && ended) return { content: [{ type: "text", text: line === 1 ? `Note: ${params.path} is empty.` : `Note: offset ${start} is beyond EOF (${line - 1} lines scanned). Retry with a smaller offset.` }], details: {} };
      let text = rendered.join("\n");
      if (byteCut) text += `\n\n[Byte limit reached. Continue with offset=${line}; line ${line} was not included.]`;
      else if (lineCut && !ended) text += `\n\n[Line window reached. Continue with offset=${line}.]`;
      else if (!ended) text += `\n\n[Read stopped before EOF. Continue with offset=${line}.]`;
      return { content: [{ type: "text", text }], details: {} as ReadToolDetails };
    },
  });
}
