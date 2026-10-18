const ENTITY_ID_PREFIXES = [
  "char",
  "hook",
  "thread",
  "lead",
  "intent",
  "fact",
  "goal",
  "asset",
  "loc",
] as const;

const ENTITY_ID_PATTERN = new RegExp(`\\b(?:${ENTITY_ID_PREFIXES.join("|")})-[0-9a-z]{4,12}\\b`, "giu");
// 不猜白名单：去裸id
const ENTITY_ID_DECORATED_GROUP_PATTERN = new RegExp(
  `[（(]\\s*(?:id|ID)\\s*[:=：]\\s*(?:${ENTITY_ID_PREFIXES.join("|")})-[0-9a-z]{4,12}\\s*[）)]`,
  "giu",
);
// 不猜白名单：去裸id
const ENTITY_ID_ASSIGNMENT_PATTERN = new RegExp(
  `\\b(?:id|ID)\\s*[:=：]\\s*(?:${ENTITY_ID_PREFIXES.join("|")})-[0-9a-z]{4,12}\\b`,
  "giu",
);

const SCRUBBED_ID = "（内部编号已隐去）";
const MAX_BUFFER_CHARS = 24;
const POSSIBLE_ENTITY_ID_TAIL = new RegExp(
  `^(?:${ENTITY_ID_PREFIXES.map((prefix) => partialAlternatives(prefix)).join("|")})(?:-[0-9a-z]{0,12})?$`,
  "iu",
);

function partialAlternatives(prefix: string): string {
  return Array.from({ length: prefix.length }, (_, index) => prefix.slice(0, index + 1)).join("|");
}

export function scrubEntityIds(text: string): string {
  if (!text) return text;
  return text
    .replace(ENTITY_ID_DECORATED_GROUP_PATTERN, "")
    .replace(ENTITY_ID_ASSIGNMENT_PATTERN, "")
    .replace(ENTITY_ID_PATTERN, SCRUBBED_ID);
}

function findBufferedTailLength(text: string): number {
  const maxStart = Math.max(0, text.length - MAX_BUFFER_CHARS);
  for (let start = maxStart; start < text.length; start += 1) {
    const tail = text.slice(start);
    if (POSSIBLE_ENTITY_ID_TAIL.test(tail)) return tail.length;
  }
  return 0;
}

export interface StreamingScrubber {
  push(text: string): string;
  flush(): string;
}

export function createStreamingScrubber(): StreamingScrubber {
  let buffer = "";

  return {
    push(text: string): string {
      const combined = buffer + text;
      const tailLength = findBufferedTailLength(combined);
      const emitText = tailLength > 0 ? combined.slice(0, -tailLength) : combined;
      buffer = tailLength > 0 ? combined.slice(-tailLength) : "";
      return scrubEntityIds(emitText);
    },
    flush(): string {
      const text = buffer;
      buffer = "";
      return scrubEntityIds(text);
    },
  };
}
