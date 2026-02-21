import { config } from "../config.js";

/**
 * Split a long message into chunks that fit within WhatsApp's limits,
 * breaking at paragraph > line > sentence > word boundaries.
 * Repairs code fences that span across chunks.
 */
export function splitMessage(
  text: string,
  maxLen: number = config.maxMessageLength
): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = findSplitPoint(remaining, maxLen);
    chunks.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return repairCodeFences(chunks);
}

function findSplitPoint(text: string, maxLen: number): number {
  // Try paragraph break (double newline)
  const paraIdx = text.lastIndexOf("\n\n", maxLen);
  if (paraIdx > maxLen * 0.3) return paraIdx + 2;

  // Try line break
  const lineIdx = text.lastIndexOf("\n", maxLen);
  if (lineIdx > maxLen * 0.3) return lineIdx + 1;

  // Try sentence end (. ! ?) followed by space
  const sentenceRegex = /[.!?]\s/g;
  let lastSentence = -1;
  let match: RegExpExecArray | null;
  while ((match = sentenceRegex.exec(text)) !== null) {
    if (match.index + 2 > maxLen) break;
    lastSentence = match.index + 2;
  }
  if (lastSentence > maxLen * 0.3) return lastSentence;

  // Try word boundary (space)
  const spaceIdx = text.lastIndexOf(" ", maxLen);
  if (spaceIdx > maxLen * 0.3) return spaceIdx + 1;

  // Hard cut as last resort
  return maxLen;
}

function repairCodeFences(chunks: string[]): string[] {
  const result: string[] = [];
  let openFence: string | null = null;

  for (let i = 0; i < chunks.length; i++) {
    let chunk = chunks[i];

    // If previous chunk left a code fence open, reopen it
    if (openFence !== null) {
      chunk = openFence + "\n" + chunk;
    }

    // Count triple-backtick fences in this chunk
    const fenceMatches = chunk.match(/^```.*$/gm) || [];
    const isOpen = fenceMatches.length % 2 !== 0;

    if (isOpen) {
      // Find the language tag of the last unclosed fence
      const lastFenceMatch = /^(```\w*)$/gm;
      let last: RegExpExecArray | null = null;
      let m: RegExpExecArray | null;
      while ((m = lastFenceMatch.exec(chunk)) !== null) {
        last = m;
      }
      openFence = last ? last[1] : "```";
      chunk = chunk + "\n```";
    } else {
      openFence = null;
    }

    result.push(chunk);
  }

  return result;
}
