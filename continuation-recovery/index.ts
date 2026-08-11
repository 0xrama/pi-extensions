/**
 * continuation-recovery — auto-continue turns that end unfinished.
 *
 * Inspired by how Command Code approaches agent reliability (same spirit
 * as their tool-call-repairs engineering article). Open models are prone to
 * three ways of ending a turn without finishing the task:
 *   (a) no visible content at all (blank/thinking-only responses),
 *   (b) hitting the output token limit mid-answer (stopReason "length"),
 *   (c) trailing off with a dangling "I'll do that now…" intent and never
 *       doing it.
 *
 * When a run ends in one of those states we queue a targeted follow-up so
 * the model actually completes the work. Per-condition caps plus a total
 * cap mean a broken model cannot loop forever; a healthy turn (visible
 * content or tool calls) resets the counters.
 *
 * This uses pi's sanctioned continuation channel: pi's agent loop drains
 * follow-up messages queued from an `agent_end` handler and runs another
 * turn ("Any messages here were queued by agent_end extension handlers and
 * need a continuation.").
 */

import type {
  AgentEndEvent,
  ExtensionAPI,
  InputEvent,
} from "@earendil-works/pi-coding-agent";

const MAX_CONSECUTIVE = 8; // hard cap across all kinds, command-code style
const LIMITS = { empty: 2, length: 3, intent: 2 } as const;
type ContinuationKind = keyof typeof LIMITS;

const PROMPTS: Record<ContinuationKind, string> = {
  empty:
    "Please continue your response. Along with thinking, also tell the user what is happening or what you plan to do next.",
  length:
    "Your previous response was cut off by the output token limit before it finished. Continue exactly where you left off — do not repeat content you already produced.",
  intent:
    "You ended your turn right after saying you were about to do something, without doing it. Do it now — make the tool calls or produce the output you described; do not restate the plan. If the task is actually complete, state the final result instead.",
};

/* Dangling-intent detection, inspired by Command Code's approach to
 * turn-completion reliability. DANGLE_START matches a trailing
 * "let me / i'll / i'm going to …" fragment; DANGLE_STOP lists polite
 * closers that are NOT dangling ("let me know if…", "over to you", …). */

const DANGLE_START =
  /^(?:(?:now|next|first|then|so|ok|okay|alright|great|perfect|good)[,.!]?\s+)*(?:let me|let's|i'll|i will|i'm going to|i am going to|we'll|we will)\b(?!\s+(?:not|never|no longer)\b)/i;

const DANGLE_STOP =
  /\b(?:let (?:me|us) know|let you know|i(?:'ll| will) (?:wait|stop|hold|pause|be here|leave|remember)|(?:i'm going to|i am going to|(?:i|we)(?:'ll| will)) need(?! to\b)|if you|when you|once you|whenever you|after you|unless you|shall i|should i|would you|want me to|feel free|happy to|glad to|over to you|up to you|your call|from now on|going forward|next time|keep (?:that|this|it) in mind)\b/i;

function stripMarkdownEdges(text: string): string {
  return text
    .replace(/^[\s>#*_`~-]+/, "")
    .replace(/[\s*_`~]+$/, "");
}

function endsWithDanglingIntent(text: string): boolean {
  const trimmed = text.replace(/[‘’]/g, "'").trim();
  if (!trimmed) return false;
  if (/:$/.test(trimmed)) return true; // "Let's fix it:" — clearly mid-thought

  const sentences = trimmed.split(/(?<=[.!?])\s+|\n+/);
  const lastSentence = stripMarkdownEdges(sentences[sentences.length - 1] ?? "");
  if (!lastSentence || lastSentence.endsWith("?")) return false;
  if (DANGLE_STOP.test(lastSentence)) return false;

  const fragments = lastSentence.split(/[:;]\s+|\s+[—–-]\s+|[—–]/);
  const lastFragment = stripMarkdownEdges(fragments[fragments.length - 1] ?? "");
  return DANGLE_START.test(lastFragment);
}

function lastAssistant(messages: AgentEndEvent["messages"]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "assistant") return message;
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  const counts = { empty: 0, length: 0, intent: 0 };
  let consecutive = 0;

  pi.on("agent_end", (event: AgentEndEvent, ctx) => {
    const last = lastAssistant(event.messages);
    if (!last) return;

    const blocks = last.content ?? [];
    const text = blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    const hadToolCalls = blocks.some((block) => block.type === "toolCall");

    // A run ending with tool calls pending means work is mid-flight; pi
    // handles the continuation itself. A healthy turn resets our counters.
    if (hadToolCalls) {
      consecutive = 0;
      counts.empty = 0;
      counts.intent = 0;
      return;
    }

    const stopReason = last.stopReason;
    if (
      stopReason === "error" ||
      stopReason === "aborted" ||
      stopReason === "deferred" ||
      stopReason === "pending"
    ) {
      return; // nothing sensible to continue from
    }

    const hadVisibleContent = text.trim() !== "";
    let kind: ContinuationKind | null = null;

    if (hadVisibleContent) {
      counts.empty = 0;
      if (stopReason === "length") {
        if (counts.length < LIMITS.length) {
          counts.length += 1;
          kind = "length";
        }
      } else if (counts.intent < LIMITS.intent && endsWithDanglingIntent(text)) {
        counts.intent += 1;
        kind = "intent";
      }
    } else if (counts.empty < LIMITS.empty) {
      counts.empty += 1;
      kind = "empty";
    }

    if (!kind) return;
    if (ctx.hasPendingMessages()) return; // pi is already continuing on its own

    consecutive += 1;
    if (consecutive > MAX_CONSECUTIVE) return;

    pi.sendUserMessage(PROMPTS[kind], { deliverAs: "followUp" });
  });

  // Real user input resets the loop budget.
  pi.on("input", (event: InputEvent) => {
    if (event.source === "interactive") {
      consecutive = 0;
      counts.empty = 0;
      counts.length = 0;
      counts.intent = 0;
    }
  });
}
