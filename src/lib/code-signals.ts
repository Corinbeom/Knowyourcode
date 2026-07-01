import type { FileSummary } from "./types";

export type CodeSignal = {
  path: string;
  kind: "route" | "component" | "function" | "config" | "data" | "test";
  name: string;
};

const MAX_SIGNALS = 40;

export function extractCodeSignals(files: FileSummary[]): CodeSignal[] {
  const signals: CodeSignal[] = [];

  for (const file of files) {
    const pathSignals = inferPathSignals(file);
    const symbolSignals = inferSymbolSignals(file);
    signals.push(...pathSignals, ...symbolSignals);
  }

  return dedupeSignals(signals).slice(0, MAX_SIGNALS);
}

export function formatSignalsForPrompt(signals: CodeSignal[]): string {
  if (!signals.length) return "- No strong code signals found";
  return signals.map((signal) => `- ${signal.kind}: ${signal.name} (${signal.path})`).join("\n");
}

function inferPathSignals(file: FileSummary): CodeSignal[] {
  const signals: CodeSignal[] = [];
  const path = file.path;
  const fileName = path.split("/").at(-1) ?? path;

  if (/\/api\/|route\.(ts|tsx|js|jsx)$|router|controller/i.test(path)) {
    signals.push({ path, kind: "route", name: fileName });
  }

  if (/\.(tsx|jsx)$/.test(path) && /component|page|layout|app\/|pages\//i.test(path)) {
    signals.push({ path, kind: "component", name: fileName.replace(/\.(tsx|jsx)$/, "") });
  }

  if (/package\.json|next\.config|vite\.config|tailwind\.config|tsconfig/i.test(path)) {
    signals.push({ path, kind: "config", name: fileName });
  }

  if (/schema|model|repository|prisma|db|database|store/i.test(path)) {
    signals.push({ path, kind: "data", name: fileName });
  }

  if (/test|spec/i.test(path)) {
    signals.push({ path, kind: "test", name: fileName });
  }

  return signals;
}

function inferSymbolSignals(file: FileSummary): CodeSignal[] {
  const signals: CodeSignal[] = [];
  const patterns = [
    /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g,
    /function\s+([A-Za-z0-9_]+)\s*\(/g,
    /export\s+default\s+function\s+([A-Za-z0-9_]+)/g,
    /export\s+const\s+([A-Za-z0-9_]+)/g,
    /const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(/g
  ];

  for (const pattern of patterns) {
    for (const match of file.excerpt.matchAll(pattern)) {
      const name = match[1];
      if (!name || name.length < 3) continue;
      signals.push({ path: file.path, kind: "function", name });
    }
  }

  return signals.slice(0, 5);
}

function dedupeSignals(signals: CodeSignal[]): CodeSignal[] {
  const seen = new Set<string>();
  return signals.filter((signal) => {
    const key = `${signal.kind}:${signal.path}:${signal.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
