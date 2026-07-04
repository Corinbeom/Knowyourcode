import type { AnalysisFocus, FileSummary } from "./types";

export type CodeSignal = {
  path: string;
  kind: "route" | "component" | "function" | "service" | "config" | "data" | "test";
  name: string;
};

const MAX_SIGNALS = 40;

export function extractCodeSignals(files: FileSummary[], focus: AnalysisFocus = "balanced"): CodeSignal[] {
  const signals: CodeSignal[] = [];

  for (const file of [...files].sort((a, b) => Number(isTestPath(a.path)) - Number(isTestPath(b.path)))) {
    const pathSignals = inferPathSignals(file);
    const symbolSignals = inferSymbolSignals(file);
    signals.push(...pathSignals, ...symbolSignals);
  }

  return dedupeSignals(signals, focus).slice(0, MAX_SIGNALS);
}

export function formatSignalsForPrompt(signals: CodeSignal[]): string {
  if (!signals.length) return "- No strong code signals found";
  return signals.map((signal) => `- ${signal.kind}: ${signal.name} (${signal.path})`).join("\n");
}

function inferPathSignals(file: FileSummary): CodeSignal[] {
  const signals: CodeSignal[] = [];
  const path = file.path;
  const fileName = path.split("/").at(-1) ?? path;

  if (/\/api\/|route\.(ts|tsx|js|jsx)$|router|controller|@RestController|@Controller/i.test(`${path}\n${file.excerpt}`)) {
    signals.push({ path, kind: "route", name: fileName });
  }

  if (/\.(tsx|jsx)$/.test(path) && /component|page|layout|app\/|pages\//i.test(path)) {
    signals.push({ path, kind: "component", name: fileName.replace(/\.(tsx|jsx)$/, "") });
  }

  if (/package\.json|next\.config|vite\.config|tailwind\.config|tsconfig/i.test(path)) {
    signals.push({ path, kind: "config", name: fileName });
  }

  if (/service/i.test(path) || /@Service/i.test(file.excerpt)) {
    signals.push({ path, kind: "service", name: fileName.replace(/\.(java|kt|ts|tsx|js|jsx)$/, "") });
  }

  if (/build\.gradle|settings\.gradle|pom\.xml|application\.(yml|yaml|properties)/i.test(path)) {
    signals.push({ path, kind: "config", name: fileName });
  }

  if (/schema|model|repository|prisma|db|database|store/i.test(path)) {
    signals.push({ path, kind: "data", name: fileName });
  }

  if (/repository|entity|domain/i.test(path) || /@(Repository|Entity)/i.test(file.excerpt)) {
    signals.push({ path, kind: "data", name: fileName.replace(/\.(java|kt)$/, "") });
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
    /const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(/g,
    /(?:public|private|protected)\s+(?:static\s+)?[A-Za-z0-9_<>, ?.[\]]+\s+([A-Za-z0-9_]+)\s*\(/g,
    /class\s+([A-Za-z0-9_]+)/g
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

function dedupeSignals(signals: CodeSignal[], focus: AnalysisFocus): CodeSignal[] {
  const seen = new Set<string>();
  return signals
    .sort((a, b) => signalPriority(b, focus) - signalPriority(a, focus))
    .filter((signal) => {
      const key = `${signal.kind}:${signal.path}:${signal.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function signalPriority(signal: CodeSignal, focus: AnalysisFocus): number {
  let score = 0;
  if (signal.kind === "route") score += 50;
  if (signal.kind === "service") score += 45;
  if (signal.kind === "component") score += 40;
  if (signal.kind === "function") score += 30;
  if (signal.kind === "data") score += 25;
  if (signal.kind === "config") score += 10;
  if (focus === "frontend" && isClientFacingPath(signal.path)) score += 80;
  if (focus === "frontend" && isServerFacingPath(signal.path)) score -= 60;
  if (focus === "backend" && isServerFacingPath(signal.path)) score += 80;
  if (focus === "backend" && isClientFacingPath(signal.path)) score -= 60;
  if (signal.kind === "test") score -= 50;
  if (isTestPath(signal.path)) score -= 80;
  return score;
}

function isClientFacingPath(path: string): boolean {
  return /(^|\/)(frontend|client|web|app|pages|components|views|screens|ui)(\/|$)|\.(tsx|jsx|vue|svelte|astro)$/i.test(path);
}

function isServerFacingPath(path: string): boolean {
  return /(^|\/)(backend|server|api|routes|controllers?|services?|repositories?|entities?|models?|domain|infra|config)(\/|$)|\.(java|kt|go|py|rb|php|cs|rs)$/i.test(path);
}

function isTestPath(path: string): boolean {
  return /(^|\/)(__tests__|test|tests|spec)(\/|$)|\.(test|spec)\.(ts|tsx|js|jsx|java|kt|py|go|rb|php|cs|rs)$/i.test(path);
}
