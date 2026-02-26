import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_FILE = path.join(__dirname, "..", "data", "state.md");

const DEBOUNCE_MS = 5_000;

// ─── State collectors (registered by each module) ───

type StateCollector = () => { section: string; data: unknown };
const collectors: StateCollector[] = [];

export function registerCollector(collector: StateCollector): void {
  collectors.push(collector);
}

// ─── Dirty flag + debounced write ───

let dirty = false;
let timer: ReturnType<typeof setTimeout> | null = null;

export function markDirty(): void {
  dirty = true;
  if (!timer) {
    timer = setTimeout(() => {
      timer = null;
      if (dirty) {
        dirty = false;
        saveState();
      }
    }, DEBOUNCE_MS);
  }
}

// ─── Save ───

function saveState(): void {
  try {
    let md = "# Flow-Bid State\n\n";
    md += `_Last saved: ${new Date().toISOString()}_\n\n`;

    for (const collect of collectors) {
      const { section, data } = collect();
      md += `## ${section}\n`;
      md += "```json\n";
      md += JSON.stringify(data, null, 2);
      md += "\n```\n\n";
    }

    // Atomic write: write to temp, then rename
    const tmpFile = STATE_FILE + ".tmp";
    fs.writeFileSync(tmpFile, md, "utf-8");
    fs.renameSync(tmpFile, STATE_FILE);
    console.log("[persistence] State saved");
  } catch (err: any) {
    console.error("[persistence] Save failed:", err.message);
  }
}

// ─── Load ───

export interface LoadedState {
  [section: string]: unknown;
}

export function loadState(): LoadedState {
  const result: LoadedState = {};

  if (!fs.existsSync(STATE_FILE)) {
    console.log("[persistence] No state file found, starting fresh");
    return result;
  }

  try {
    const content = fs.readFileSync(STATE_FILE, "utf-8");
    // Parse markdown sections with fenced JSON blocks
    const sectionRegex = /^## (.+)$/gm;
    const jsonBlockRegex = /```json\n([\s\S]*?)```/g;

    const sections: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = sectionRegex.exec(content)) !== null) {
      sections.push(match[1].trim());
    }

    let blockIndex = 0;
    while ((match = jsonBlockRegex.exec(content)) !== null) {
      if (blockIndex < sections.length) {
        try {
          result[sections[blockIndex]] = JSON.parse(match[1]);
        } catch {
          console.error(`[persistence] Failed to parse section: ${sections[blockIndex]}`);
        }
      }
      blockIndex++;
    }

    console.log(`[persistence] Loaded state: ${Object.keys(result).join(", ")}`);
  } catch (err: any) {
    console.error("[persistence] Load failed:", err.message);
  }

  return result;
}
