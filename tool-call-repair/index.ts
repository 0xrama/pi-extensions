/**
 * tool-call-repair — schema-driven repair of malformed LLM tool calls.
 *
 * Inspired by Command Code's engineering article on tool-call repairs
 * (https://commandcode.ai/docs/harness-engineering/tool-call-repairs):
 * schema-driven coercion + per-tool field-alias maps + in-context
 * `<repair_note>` feedback. Open models (DeepSeek, Qwen, Kimi, GLM, ...)
 * produce structurally malformed tool calls far more often than frontier
 * models: wrong field names, values as JSON strings, bare scalars where an
 * array belongs, markdown-wrapped paths, nulls where scalars belong,
 * hallucinated fields.
 *
 * Pipeline per tool call:
 *   1. Load the tool's parameter schema (hardcoded table for the seven
 *      built-ins + a lazy cache over pi.getAllTools() for custom tools).
 *   2. Run the repair catalogue over every field:
 *        - drop null/undefined fields
 *        - drop empty-object placeholders where a scalar is expected
 *        - coerce "42" -> 42, "true" -> true
 *        - parse JSON-stringified arrays/objects
 *        - wrap a bare scalar into a one-element array
 *        - strip markdown link wrappers off path fields
 *        - rename alias fields onto the canonical schema name (alias map)
 *        - drop unknown keys (built-ins only; never for custom tools)
 *   3. If required fields are STILL missing after repair, block the call
 *      with a corrective message the model can retry from (mirrors
 *      Command Code's "Invalid input for tool ..." error, including the
 *      "arguments were likely truncated in transit" diagnostic).
 *   4. On success, prepend the applied repairs as <repair_note> hints to
 *      the tool result — immediate in-context feedback, so the model
 *      stops repeating the same mistake within the session.
 *
 * Nothing here calls a service and no state leaves the process.
 */

import type {
  ExtensionAPI,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

/* ------------------------------------------------------------------ *
 * Schema model
 * ------------------------------------------------------------------ */

interface PropSchema {
  type?: string;
  items?: PropSchema;
  properties?: Record<string, PropSchema>;
  required?: string[];
  additionalProperties?: boolean;
}
interface ToolSchema extends PropSchema {
  type: string;
  properties: Record<string, PropSchema>;
}

/** The seven built-in tool schemas (from pi-agent-core tool definitions). */
const BUILTIN_SCHEMAS: Record<string, ToolSchema> = {
  read: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string" },
      offset: { type: "integer" },
      limit: { type: "integer" },
    },
  },
  edit: {
    type: "object",
    additionalProperties: false,
    required: ["path", "edits"],
    properties: {
      path: { type: "string" },
      edits: {
        type: "array",
        items: {
          type: "object",
          required: ["oldText", "newText"],
          properties: {
            oldText: { type: "string" },
            newText: { type: "string" },
          },
        },
      },
    },
  },
  write: {
    type: "object",
    additionalProperties: false,
    required: ["path", "content"],
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
  },
  bash: {
    type: "object",
    additionalProperties: false,
    required: ["command"],
    properties: {
      command: { type: "string" },
      timeout: { type: "number" },
    },
  },
  grep: {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      glob: { type: "string" },
      ignoreCase: { type: "boolean" },
      literal: { type: "boolean" },
      context: { type: "number" },
      limit: { type: "number" },
    },
  },
  find: {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      limit: { type: "number" },
    },
  },
  ls: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      path: { type: "string" },
      limit: { type: "number" },
    },
  },
};

/** Canonical field -> aliases open models actually send. */
const ALIASES: Record<string, Record<string, string[]>> = {
  read: {
    path: [
      "file_path", "filePath", "filepath", "absolute_path", "absolutePath",
      "file", "target_file", "targetFile", "pathname", "filename",
    ],
  },
  edit: {
    path: [
      "file_path", "filePath", "filepath", "absolute_path", "absolutePath",
      "file", "target_file", "targetFile", "pathname", "filename",
    ],
    edits: ["changes", "diff", "replacements", "edit_blocks", "blocks", "patches"],
  },
  write: {
    path: [
      "file_path", "filePath", "filepath", "absolute_path", "absolutePath",
      "file", "target_file", "targetFile", "pathname", "filename",
    ],
    content: ["text", "body", "data", "contents", "fileContent", "file_content", "file_contents"],
  },
  bash: {
    command: ["cmd", "bash", "shell", "script", "commandLine", "command_line", "command_str", "cmd_str"],
    timeout: ["timeout_ms", "timeoutMs", "timeout_seconds", "timeoutMillis"],
  },
  grep: {
    pattern: ["query", "regex", "search", "q", "expression", "text", "regexp", "regex_pattern"],
    path: ["directory", "dir", "folder", "searchPath", "search_path", "root"],
  },
  find: {
    pattern: ["query", "glob", "expression", "search", "name", "include", "filename"],
    path: ["directory", "dir", "folder", "searchPath", "search_path", "root"],
  },
  ls: {
    path: ["directory", "dir", "folder", "target", "targetPath", "target_dir"],
  },
};

/** Item-level aliases for array-of-object fields (edit.edits[] items). */
const ITEM_ALIASES: Record<string, string[]> = {
  oldText: [
    "old_string", "oldValue", "oldString", "old_str", "oldStr", "old",
    "from", "old_value", "old_text", "oldContent", "old_content",
    "before", "search", "find",
  ],
  newText: [
    "new_string", "newValue", "newString", "new_str", "newStr", "to",
    "new_value", "new_text", "newContent", "new_content",
    "after", "replace", "replacement",
  ],
};

/* ------------------------------------------------------------------ *
 * Schema cache
 * ------------------------------------------------------------------ */

function toPropSchema(schema: unknown): PropSchema | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const s = schema as Record<string, unknown>;
  const out: PropSchema = {};
  if (typeof s.type === "string") out.type = s.type;
  if (s.items) out.items = toPropSchema(s.items);
  if (s.properties && typeof s.properties === "object") {
    out.properties = {};
    for (const [key, value] of Object.entries(s.properties as Record<string, unknown>)) {
      out.properties[key] = toPropSchema(value) ?? {};
    }
  }
  if (Array.isArray(s.required)) out.required = s.required as string[];
  if (typeof s.additionalProperties === "boolean") out.additionalProperties = s.additionalProperties;
  return Object.keys(out).length > 0 ? out : undefined;
}

function toToolSchema(schema: unknown): ToolSchema | undefined {
  const props = toPropSchema(schema);
  if (!props?.properties) return undefined;
  return {
    ...props,
    type: "object",
    properties: props.properties,
  };
}

/* ------------------------------------------------------------------ *
 * Repair rules
 * ------------------------------------------------------------------ */

interface RepairInput {
  toolName: string;
  key: string;
  value: unknown;
  expectedType: string | undefined;
  isKnownKey: boolean;
  knownKeys: Set<string>;
  input: Record<string, unknown>;
}
type RepairRule = (e: RepairInput) => false | { hint: string };

const dropNullUndefined: RepairRule = ({ key, value, input }) => {
  if (value == null) {
    delete input[key];
    return { hint: `Dropped null/undefined field \`${key}\` — omit it instead of sending null.` };
  }
  return false;
};

const dropEmptyObjectPlaceholder: RepairRule = ({ key, value, expectedType, input }) => {
  if (
    expectedType !== "object" &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value as object).length === 0
  ) {
    delete input[key];
    return { hint: `Dropped empty-object placeholder \`${key}\`.` };
  }
  return false;
};

const coerceStringToNumber: RepairRule = ({ key, value, expectedType, input }) => {
  if (
    (expectedType === "number" || expectedType === "integer") &&
    typeof value === "string" &&
    value.trim() !== "" &&
    !Number.isNaN(Number(value))
  ) {
    input[key] = Number(value);
    return { hint: `Coerced string \`${key}\` to a number.` };
  }
  return false;
};

const coerceStringToBoolean: RepairRule = ({ key, value, expectedType, input }) => {
  if (
    expectedType === "boolean" &&
    (value === "true" || value === "false")
  ) {
    input[key] = value === "true";
    return { hint: `Coerced string \`${key}\` to a boolean.` };
  }
  return false;
};

const parseJsonStringifiedArray: RepairRule = ({ key, value, expectedType, input }) => {
  if (expectedType !== "array" || Array.isArray(value)) return false;
  if (typeof value !== "string" || !value.trim().startsWith("[")) return false;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      input[key] = parsed;
      return { hint: `Parsed JSON-stringified array \`${key}\`.` };
    }
  } catch {
    /* not JSON — leave it */
  }
  return false;
};

const parseJsonStringifiedObject: RepairRule = ({ key, value, expectedType, input }) => {
  const isObjectValue = typeof value === "object" && value !== null && !Array.isArray(value);
  if (expectedType !== "object" || isObjectValue) return false;
  if (typeof value !== "string" || !value.trim().startsWith("{")) return false;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      input[key] = parsed;
      return { hint: `Parsed JSON-stringified object \`${key}\`.` };
    }
  } catch {
    /* not JSON — leave it */
  }
  return false;
};

const wrapBareScalarAsArray: RepairRule = ({ key, value, expectedType, input }) => {
  if (expectedType === "array" && !Array.isArray(value)) {
    input[key] = [value];
    return { hint: `Wrapped scalar \`${key}\` in a one-element array.` };
  }
  return false;
};

const stripMarkdownLinkFromPath: RepairRule = ({ key, value, expectedType, input }) => {
  if (expectedType !== "string" || typeof value !== "string") return false;
  if (!/path$/i.test(key)) return false;
  const match = /^\[[^\]]*\]\(([^)]+)\)$/.exec(value.trim());
  if (match?.[1]) {
    input[key] = match[1];
    return { hint: `Stripped markdown link from \`${key}\`.` };
  }
  return false;
};

const renameAliasedField: RepairRule = ({ toolName, key, value, isKnownKey, knownKeys, input }) => {
  if (isKnownKey) return false;
  const toolAliases = ALIASES[toolName];
  if (!toolAliases) return false;
  for (const [canonical, aliases] of Object.entries(toolAliases)) {
    if (!aliases.includes(key)) continue;
    if (!knownKeys.has(canonical)) continue; // canonical already present -> keep it
    const current = input[canonical];
    if (current !== undefined && current !== "") continue;
    if (value == null || (typeof value === "string" && value === "")) continue;
    input[canonical] = value;
    delete input[key];
    return {
      hint: `Renamed \`${key}\` to \`${canonical}\` for tool "${toolName}". Use \`${canonical}\` next time — \`${key}\` is not a valid field for this tool.`,
    };
  }
  return false;
};

const dropUnknownKey: RepairRule = ({ key, isKnownKey, input }) => {
  if (!isKnownKey) {
    delete input[key];
    return { hint: `Dropped unknown field \`${key}\`.` };
  }
  return false;
};

const RULES: RepairRule[] = [
  dropNullUndefined,
  dropEmptyObjectPlaceholder,
  coerceStringToNumber,
  coerceStringToBoolean,
  parseJsonStringifiedArray,
  parseJsonStringifiedObject,
  wrapBareScalarAsArray,
  stripMarkdownLinkFromPath,
  renameAliasedField,
  dropUnknownKey,
];

interface RepairNote {
  key: string;
  fix: string;
  rule: string;
}

/** Special-case: legacy edit calls with oldText/newText (or their aliases)
 * passed at the TOP level instead of inside edits[]. */
function repairLegacyEditArgs(input: Record<string, unknown>): RepairNote[] {
  const notes: RepairNote[] = [];
  if ("edits" in input) return notes;

  const findValue = (canonical: string): { key: string; value: unknown } | undefined => {
    for (const key of [canonical, ...(ITEM_ALIASES[canonical] ?? [])]) {
      if (key in input && typeof input[key] === "string") {
        return { key, value: input[key] };
      }
    }
    return undefined;
  };
  const old = findValue("oldText");
  const neu = findValue("newText");
  if (!old || !neu) return notes;

  input.edits = [{ oldText: old.value, newText: neu.value }];
  delete input[old.key];
  delete input[neu.key];
  notes.push({
    key: "edits",
    fix: `Wrapped top-level \`${old.key}\`/\`${neu.key}\` into an \`edits\` array as \`edits: [{oldText, newText}]\`. Use that shape next time.`,
    rule: "repairLegacyEditArgs",
  });
  return notes;
}

function runCatalogue(
  toolName: string,
  schema: ToolSchema,
  input: Record<string, unknown>,
  notes: RepairNote[],
  options: { keyPrefix?: string; itemAliases?: boolean } = {},
): void {
  const { keyPrefix = "", itemAliases = false } = options;
  const properties = schema.properties ?? {};
  const knownKeys = new Set(Object.keys(properties));
  const strictKeys = schema.additionalProperties === false;

  for (const key of Object.keys(input)) {
    const prop = properties[key];
    const isKnownKey = knownKeys.has(key);
    const ctx: RepairInput = {
      toolName,
      key,
      value: input[key],
      expectedType: prop?.type,
      isKnownKey,
      knownKeys,
      input,
    };
    if (isKnownKey) {
      for (const rule of RULES) {
        if (rule === dropUnknownKey) continue;
        const result = rule(ctx);
        if (result !== false) {
          notes.push({ key: `${keyPrefix}${key}`, fix: result.hint, rule: rule.name });
          break;
        }
      }
    } else {
      // Unknown key. Try, in order: drop nulls (safe), alias rename (the
      // point of the alias map), then drop the key — but only when the
      // schema is strict (built-ins). Custom-tool extra fields are left
      // alone: we never drop data we cannot attribute to a typo.
      const relevant = [dropNullUndefined, renameAliasedField];
      if (strictKeys || itemAliases) relevant.push(dropUnknownKey);
      for (const rule of relevant) {
        const result = rule(ctx);
        if (result !== false) {
          notes.push({ key: `${keyPrefix}${key}`, fix: result.hint, rule: rule.name });
          break;
        }
      }
    }
  }

  // Descend into array-of-object fields (e.g. edit.edits[]) and repair items.
  for (const [key, prop] of Object.entries(properties)) {
    const items = prop?.items;
    if (!items?.properties) continue;
    const value = input[key];
    if (!Array.isArray(value)) continue;
    value.forEach((item, index) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) return;
      runCatalogue(
        toolName,
        { ...items, properties: items.properties } as ToolSchema,
        item as Record<string, unknown>,
        notes,
        { keyPrefix: `${keyPrefix}${key}[${index}].`, itemAliases: true },
      );
    });
  }
}

/** Build the corrective message when required fields are still missing. */
function buildMissingFieldMessage(
  toolName: string,
  schema: ToolSchema,
  input: Record<string, unknown>,
  originalInput: Record<string, unknown>,
  notes: RepairNote[],
): string {
  const missing = (schema.required ?? []).filter(
    (field) => input[field] == null || input[field] === "",
  );
  const lines: string[] = [
    `Invalid input for tool "${toolName}". Please correct and retry:`,
    ...missing.map((field) => `  • ${field}: required field is missing`),
  ];
  const received = Object.keys(originalInput);
  if (received.length > 0) {
    lines.push(`Received fields: ${received.join(", ")}`);
  } else {
    lines.push(
      "No arguments were received at all ({}) — the tool-call arguments were likely truncated or failed to parse in transit. Resend the COMPLETE call with every required field populated.",
    );
  }
  if (notes.length > 0) {
    lines.push(
      "Field-name corrections already recognized — apply them when you retry:",
      ...notes.map((note) => `  • ${note.fix}`),
    );
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * Extension
 * ------------------------------------------------------------------ */

export default function (pi: ExtensionAPI) {
  let dynamicSchemas: Map<string, ToolSchema> | null = null;

  const getSchema = (toolName: string): ToolSchema | undefined => {
    const builtin = BUILTIN_SCHEMAS[toolName];
    if (builtin) return builtin;
    if (!dynamicSchemas) {
      dynamicSchemas = new Map();
      try {
        for (const tool of pi.getAllTools()) {
          const schema = toToolSchema((tool.parameters as unknown));
          if (schema) dynamicSchemas.set(tool.name, schema);
        }
      } catch {
        /* getAllTools not ready yet — cache stays empty, custom tools skipped */
      }
    }
    return dynamicSchemas.get(toolName);
  };

  // toolCallId -> repair notes to attach to the result
  const pendingNotes = new Map<string, RepairNote[]>();

  pi.on("tool_call", (event: ToolCallEvent) => {
    const toolName = event.toolName;
    const schema = getSchema(toolName);
    if (!schema) return; // unknown tool — no schema, no repair

    const originalInput = { ...(event.input as unknown as Record<string, unknown>) };
    if (Object.keys(originalInput).length === 0 && !event.input) {
      // Defensive: some providers hand us an empty args object; leave as-is.
      return;
    }
    const input = { ...originalInput };

    const notes: RepairNote[] = repairLegacyEditArgs(input);
    runCatalogue(toolName, schema, input, notes);

    // Still missing required fields -> block with a corrective reason.
    const required = schema.required ?? [];
    const stillMissing = required.some(
      (field) => input[field] == null || input[field] === "",
    );
    if (stillMissing && required.length > 0) {
      return {
        block: true,
        reason: buildMissingFieldMessage(toolName, schema, input, originalInput, notes),
      };
    }

    if (notes.length > 0) {
      pendingNotes.set(event.toolCallId, notes);
      // Mutate the event input in place (pi contract: later handlers and
      // execution see these changes).
      const target = event.input as unknown as Record<string, unknown>;
      for (const key of Object.keys(target)) delete target[key];
      Object.assign(target, input);
    }
  });

  pi.on("tool_result", (event: ToolResultEvent) => {
    const notes = pendingNotes.get(event.toolCallId);
    if (!notes || notes.length === 0) return;
    pendingNotes.delete(event.toolCallId);
    if (event.isError) return; // keep error output clean; the model gets the tool's own error

    const noteText = notes
      .map((note) => `<repair_note>${note.fix}</repair_note>`)
      .join("\n");
    const content = [...event.content];
    const firstTextIndex = content.findIndex((block) => block.type === "text");
    if (firstTextIndex >= 0) {
      const block = content[firstTextIndex];
      if (block.type === "text") {
        content[firstTextIndex] = { type: "text", text: `${noteText}\n\n${block.text}` };
      }
    } else {
      content.unshift({ type: "text", text: noteText });
    }
    return { content };
  });
}
