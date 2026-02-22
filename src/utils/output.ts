import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const quips = {
  success: [
    "Yeah, if you could go ahead and add that config, that'd be great.",
    "Welcome to Initech. I mean, your org.",
    "That's... that's a terrific TPS report. Really terrific.",
    "Looks like somebody's got a case of the promotions.",
  ],
  error: [
    "PC Load Letter? What does that even mean?",
    "I'm gonna need you to go ahead and fix that.",
    "Somebody's got a case of the Mondays.",
  ],
  empty: [
    "Looks like someone has a case of the Mondays.",
    "I... I believe you have my stapler.",
    "What exactly would you say... you do here?",
  ],
};

export function randomQuip(category: keyof typeof quips): string {
  const arr = quips[category];
  return arr[Math.floor(Math.random() * arr.length)]!;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}b`;
  return `${(bytes / 1024).toFixed(1)}kb`;
}

/**
 * Available built-in persona names.
 */
const BUILTIN_PERSONAS = ["developer", "designer", "support", "ea", "ops", "strategy", "security"];

/**
 * Find the personas directory — works from both dist and source layouts.
 */
function findPersonasDir(): string {
  const candidates = [
    join(__dirname, "..", "..", "personas"),          // dist/src/utils -> personas
    join(__dirname, "..", "..", "..", "personas"),     // deeper nesting
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error("Can't find personas directory.");
}

/**
 * Resolve a report path argument to an actual file path.
 *
 * Lookup order:
 * 1. If it contains `/` or ends in `.tps` → treat as file path
 * 2. Otherwise → look for matching persona in built-in personas directory
 * 3. If not found → error with Office Space flavor
 */
export function resolveReportPath(input: string): string {
  // Direct file path
  if (input.includes("/") || input.endsWith(".tps")) {
    if (!existsSync(input)) {
      throw new Error(`PC Load Letter? Couldn't read file: ${input}\nCheck the path and try again.`);
    }
    return input;
  }

  // Built-in persona lookup
  const personaName = input.toLowerCase();
  try {
    const personasDir = findPersonasDir();
    const personaPath = join(personasDir, `${personaName}.tps`);
    if (existsSync(personaPath)) {
      return personaPath;
    }
  } catch {
    // personas dir not found, fall through
  }

  throw new Error(
    `I'm gonna need you to be more specific about that TPS report.\n\n` +
    `"${input}" is not a file path or a known persona.\n` +
    `Built-in personas: ${BUILTIN_PERSONAS.join(", ")}`
  );
}
