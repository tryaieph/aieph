// Minimal YAML frontmatter reader/writer — supports only what MemoryEntry needs:
// scalar strings, and flow-style string arrays (`[a, b, c]`). Not a general YAML parser.

const DELIM = "---";

function quoteIfNeeded(value: string): string {
  if (value === "") return '""';
  const needsQuote = /[:#\[\]{}",\n]|^[\s]|[\s]$/.test(value) || /^(true|false|null|~)$/i.test(value);
  if (!needsQuote) return value;
  return JSON.stringify(value);
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      if (trimmed.startsWith('"')) return JSON.parse(trimmed) as string;
      return trimmed.slice(1, -1).replace(/''/g, "'");
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/** Splits a flow-array body on top-level commas, respecting quoted segments (incl. `\"` escapes). */
function splitFlowItems(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (inQuote === '"' && ch === "\\" && i + 1 < inner.length) {
      current += ch + inner[i + 1];
      i++;
      continue;
    }
    if (inQuote) {
      current += ch;
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
      current += ch;
    } else if (ch === ",") {
      items.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") items.push(current.trim());
  return items;
}

function parseFlowArray(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (inner.trim() === "") return [];
  return splitFlowItems(inner).map(unquote).filter((s) => s.length > 0);
}

function stringifyArray(values: string[]): string {
  return `[${values.map(quoteIfNeeded).join(", ")}]`;
}

export type FrontmatterDoc = {
  fields: Record<string, string | string[]>;
  body: string;
};

/** Parses `---\nkey: value\n---\nbody`. Returns null if no frontmatter block is found. */
export function parseFrontmatter(raw: string): FrontmatterDoc | null {
  if (!raw.startsWith(DELIM)) return null;
  const afterFirst = raw.slice(DELIM.length);
  const endIndex = afterFirst.indexOf(`\n${DELIM}`);
  if (endIndex === -1) return null;

  const yamlBlock = afterFirst.slice(0, endIndex).replace(/^\r?\n/, "");
  const rest = afterFirst.slice(endIndex + 1 + DELIM.length);
  const body = rest.replace(/^\r?\n/, "");

  const fields: Record<string, string | string[]> = {};
  for (const line of yamlBlock.split("\n")) {
    if (line.trim() === "") continue;
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const valueRaw = line.slice(sep + 1).trim();
    if (valueRaw.startsWith("[")) {
      fields[key] = parseFlowArray(valueRaw);
    } else {
      fields[key] = unquote(valueRaw);
    }
  }

  return { fields, body };
}

/** Serializes fields + body back into a `---\n...\n---\nbody` document. Key order is preserved. */
export function stringifyFrontmatter(fields: Record<string, string | string[]>, body: string): string {
  const lines: string[] = [DELIM];
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: ${stringifyArray(value)}`);
    } else {
      lines.push(`${key}: ${quoteIfNeeded(value)}`);
    }
  }
  lines.push(DELIM);
  return `${lines.join("\n")}\n${body}`;
}
