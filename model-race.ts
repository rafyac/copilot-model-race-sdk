/**
 * model-race.ts
 *
 * Multi-model "race" demo built on the GitHub Copilot SDK.
 *
 * Runs the SAME prompt against N models at the SAME time (concurrently),
 * shows a live leaderboard, and ranks them on:
 *   - Speed:        total wall-clock time and model generation time (API)
 *   - Token spend:  input / output / TOTAL tokens consumed   <-- headline metric
 *   - Cost:         AI credits (token-based billing; 1 credit = $0.01 USD)
 *
 * Default race (fast peers + a frontier reference panel):
 *   MAI-Code-1-Flash, Claude Haiku 4.5, GPT-5.4 mini, GPT-5 mini, Gemini 3.5 Flash,
 *   Claude Sonnet 4.6, GPT-5.4, Claude Opus 4.6
 *
 * Usage:
 *   npm run race                         # interactive setup
 *   npm run race -- --models mai,claude-haiku-4.5,gpt-5.4-mini,gemini-3.5-flash
 *   npm run race -- --prompt "Write a debounce function in TS"
 *   npm run race -- --judge gpt-5.5     # choose the quality judge
 *   npm run race -- --no-judge          # skip quality review
 *   npm run race -- --no-stream     # hide the live leaderboard, just print the summary
 */

import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { ModelInfo, SessionEvent } from "@github/copilot-sdk";
import { checkbox, input, select } from "@inquirer/prompts";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

// ----------------------------------------------------------------------------
// CLI args
// ----------------------------------------------------------------------------
export type Args = Record<string, string | boolean>;

export function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-stream") out.stream = false;
    else if (a === "--no-judge") out.judge = false;
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

export const DEFAULT_PROMPT =
  "Write a Python function that checks if a string is a valid palindrome, " +
  "ignoring punctuation, spaces, and case. Include 3 unit tests.";

// Keep the race fair: a pure code-generation answer in chat, no tool/file IO
// (which would add variable latency and make the comparison noisy).
const PROMPT_GUARDRAIL =
  "\n\nRespond with the complete solution directly in your reply as a single " +
  "code block. Do not create or edit files, and do not run any tools.";

// Live in-place animation requires a TTY: the renderer collapses frames with a
// cursor-up escape (\x1b[NA), which only works on a real terminal. When stdout
// is piped/redirected, repainting would stack every frame as a new table, so we
// disable the animation there and just print one final table after the race.
const isTTY = Boolean(process.stdout.isTTY);
const showTable = args.stream !== false;
const streamLive = showTable && isTTY;

// Default: fast peers (MAI, Haiku, GPT mini x2, Gemini Flash) plus a frontier
// reference panel (Sonnet 4.6, GPT-5.4, Opus 4.6) so quality wins can show up
// against the speed wins. Frontier models cost more AI credits per run.
export const DEFAULT_MODELS = [
  "mai",
  "claude-haiku-4.5",
  "gpt-5.4-mini",
  "gpt-5-mini",
  "gemini-3.5-flash",
  "claude-sonnet-4.6",
  "gpt-5.4",
  "claude-opus-4.6",
];

// Quality review (LLM-as-judge). Default judge is a frontier model that is NOT
// in the default lineup, to avoid self-preference bias. Disable with --no-judge.
export const DEFAULT_JUDGE = "gpt-5.5";

export interface RaceConfig {
  modelQueries: string[];
  userPrompt: string;
  judgeEnabled: boolean;
  judgeQuery: string;
}

function hasStringArg(value: string | boolean | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function splitCsv(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export function initialRaceConfig(cliArgs: Args): RaceConfig {
  return {
    modelQueries: hasStringArg(cliArgs.models) ? splitCsv(cliArgs.models) : DEFAULT_MODELS,
    userPrompt: hasStringArg(cliArgs.prompt) ? cliArgs.prompt.trim() : DEFAULT_PROMPT,
    judgeEnabled: cliArgs.judge !== false,
    judgeQuery: hasStringArg(cliArgs.judge) ? cliArgs.judge.trim() : DEFAULT_JUDGE,
  };
}

export function allRaceInputsSupplied(cliArgs: Args): boolean {
  return (
    hasStringArg(cliArgs.models) &&
    hasStringArg(cliArgs.prompt) &&
    (cliArgs.judge === false || hasStringArg(cliArgs.judge))
  );
}

function shouldRunSetup(cliArgs: Args): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && !allRaceInputsSupplied(cliArgs);
}

export function modelChoiceLabel(model: ModelInfo): string {
  return model.name === model.id ? model.name : `${model.name} (${model.id})`;
}

export function defaultModelIds(models: ModelInfo[], queries: string[]): Set<string> {
  const ids = new Set<string>();
  for (const query of queries) {
    try {
      ids.add(resolveModel(models, query).id);
    } catch {
      // Invalid user-supplied defaults are surfaced later by normal model resolution.
    }
  }
  return ids;
}

export function defaultModelsInOrder(models: ModelInfo[], queries: string[]): ModelInfo[] {
  const seen = new Set<string>();
  const ordered: ModelInfo[] = [];
  for (const query of queries) {
    try {
      const model = resolveModel(models, query);
      if (!seen.has(model.id)) {
        seen.add(model.id);
        ordered.push(model);
      }
    } catch {
      // Invalid user-supplied defaults are surfaced later by normal model resolution.
    }
  }
  return ordered;
}

async function setupRaceConfig(cliArgs: Args, models: ModelInfo[]): Promise<RaceConfig> {
  const config = initialRaceConfig(cliArgs);
  if (!shouldRunSetup(cliArgs)) return config;

  line(`${C.bold}${C.magenta}Model Race setup${C.reset}  ${C.dim}fill in the missing race inputs${C.reset}`);
  line();

  if (!hasStringArg(cliArgs.models)) {
    const selectedDefaults = defaultModelIds(models, config.modelQueries);
    const defaultsFirst = [
      ...defaultModelsInOrder(models, config.modelQueries),
      ...models.filter((model) => !selectedDefaults.has(model.id)),
    ];
    config.modelQueries = await checkbox<string>({
      message: "Tab 1/3 - choose models to race",
      pageSize: 12,
      choices: defaultsFirst.map((model) => ({
        name: modelChoiceLabel(model),
        value: model.id,
        checked: selectedDefaults.has(model.id),
      })),
      validate: (answers) => answers.length > 0 || "Choose at least one model.",
    });
  }

  if (cliArgs.judge !== false && !hasStringArg(cliArgs.judge)) {
    let defaultJudgeId = "";
    try {
      defaultJudgeId = resolveModel(models, config.judgeQuery).id;
    } catch {
      defaultJudgeId = "";
    }

    const selectedJudge = await select<string>({
      message: "Tab 2/3 - choose judge model",
      pageSize: 12,
      default: defaultJudgeId || "__none__",
      choices: [
        { name: "None (disable quality review)", value: "__none__" },
        ...models.map((model) => ({
          name: modelChoiceLabel(model),
          value: model.id,
        })),
      ],
    });

    config.judgeEnabled = selectedJudge !== "__none__";
    config.judgeQuery = config.judgeEnabled ? selectedJudge : "";
  }

  if (!hasStringArg(cliArgs.prompt)) {
    const selectedPrompt = await input({
      message: "Tab 3/3 - prompt to run",
      default: config.userPrompt,
      validate: (value) => value.trim().length > 0 || "Prompt cannot be empty.",
    });
    config.userPrompt = selectedPrompt.trim();
  }

  line();
  return config;
}

// ----------------------------------------------------------------------------
// Model resolution & tiering
// ----------------------------------------------------------------------------
export function resolveModel(models: ModelInfo[], query: string): ModelInfo {
  const q = query.toLowerCase();
  let m = models.find((x) => x.id.toLowerCase() === q);
  if (m) return m;
  if (q === "mai" || (q.includes("mai") && q.includes("flash"))) {
    m =
      models.find((x) => /mai.*code.*flash|mai-code-1-flash/i.test(x.id)) ||
      models.find((x) => /mai/i.test(x.id) && /flash/i.test(x.id)) ||
      models.find((x) => /mai/i.test(x.name) && /flash/i.test(x.name));
    if (m) return m;
  }
  m =
    models.find((x) => x.id.toLowerCase().includes(q)) ||
    models.find((x) => x.name.toLowerCase().includes(q));
  if (m) return m;
  throw new Error(
    `Could not resolve a model matching "${query}". Available: ${models
      .map((x) => x.id)
      .join(", ")}`,
  );
}

// Rough tier label for narrative context (fast/small vs frontier/large).
function tierOf(m: ModelInfo): "fast" | "frontier" {
  const id = m.id.toLowerCase();
  if (/sonnet|opus|gpt-5\.5|gpt-5\.4(?!-mini)|gpt-5\.3|gemini-3\.1-pro|codex/.test(id)) {
    return "frontier";
  }
  if (/flash|mini|haiku|mai/.test(id)) return "fast";
  const ctx = m.capabilities?.limits?.max_context_window_tokens ?? 0;
  return ctx >= 400_000 ? "frontier" : "fast";
}

// Per-token pricing (USD per 1 MILLION tokens), keyed by lower-cased model name.
// Source: GitHub Docs "Models and pricing for GitHub Copilot" (fetched 2026-06-11).
export const PRICING_REFERENCE_URL =
  "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing";
// Enterprise/Business billing is now token-based: usage is converted to GitHub
// AI Credits where 1 AI credit = $0.01 USD. The legacy per-request multiplier
// model is obsolete for these plans, so we surface AI-credit cost instead.
// (Cached-input/cache-write rates exist too, but the SDK usage event only gives
// us plain input/output token counts, so we price those two.)
export interface Pricing {
  input: number; // USD per 1M input tokens
  output: number; // USD per 1M output tokens
}
export const MODEL_PRICING: Record<string, Pricing> = {
  "claude haiku 4.5": { input: 1.0, output: 5.0 },
  "claude sonnet 4": { input: 3.0, output: 15.0 },
  "claude sonnet 4.5": { input: 3.0, output: 15.0 },
  "claude sonnet 4.6": { input: 3.0, output: 15.0 },
  "claude opus 4.5": { input: 5.0, output: 25.0 },
  "claude opus 4.6": { input: 5.0, output: 25.0 },
  "claude opus 4.7": { input: 5.0, output: 25.0 },
  "claude opus 4.8": { input: 5.0, output: 25.0 },
  "claude fable 5": { input: 10.0, output: 50.0 },
  "gemini 2.5 pro": { input: 1.25, output: 10.0 },
  "gemini 3 flash": { input: 0.5, output: 3.0 },
  "gemini 3.1 pro": { input: 2.0, output: 12.0 },
  "gemini 3.5 flash": { input: 1.5, output: 9.0 },
  "gpt-5 mini": { input: 0.25, output: 2.0 },
  "gpt-5.3-codex": { input: 1.75, output: 14.0 },
  "gpt-5.4 mini": { input: 0.75, output: 4.5 },
  "gpt-5.4 nano": { input: 0.2, output: 1.25 },
  "gpt-5.4": { input: 2.5, output: 15.0 },
  "gpt-5.5": { input: 5.0, output: 30.0 },
  "raptor mini": { input: 0.25, output: 2.0 },
  "mai-code-1-flash": { input: 0.75, output: 4.5 },
};

export function pricingFor(m: ModelInfo): Pricing | undefined {
  const name = m.name.toLowerCase().trim();
  if (name in MODEL_PRICING) return MODEL_PRICING[name];
  const id = m.id.toLowerCase().replace(/-internal$/, "");
  if (id in MODEL_PRICING) return MODEL_PRICING[id];
  // Longest key first so "gpt-5.4 mini" wins over "gpt-5.4".
  const keys = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (name.includes(k) || id.includes(k)) return MODEL_PRICING[k];
  }
  return undefined;
}

// AI credits for a racer's actual token usage. 1 AI credit = $0.01 USD, so
// credits = USD * 100 = in/1e6 * inputRate * 100 + out/1e6 * outputRate * 100.
function aiCredits(r: Racer): number | undefined {
  if (!r.pricing) return undefined;
  return (
    (r.inputTokens / 1_000_000) * r.pricing.input * 100 +
    (r.outputTokens / 1_000_000) * r.pricing.output * 100
  );
}

function fmtCredits(n?: number): string {
  if (n === undefined) return "n/a";
  return n >= 100 ? n.toFixed(0) : n.toFixed(2);
}

function knownCreditTotal(racers: Racer[]): number {
  return racers.reduce((a, r) => a + (aiCredits(r) ?? 0), 0);
}

function unpricedCount(racers: Racer[]): number {
  return racers.filter((r) => !r.pricing).length;
}

function fmtCreditTotal(racers: Racer[]): string {
  const known = fmtCredits(knownCreditTotal(racers));
  const missing = unpricedCount(racers);
  return missing ? `${known} known + ${missing} unpriced` : known;
}

function fmtCreditDollarTotal(racers: Racer[]): string {
  const suffix = unpricedCount(racers) ? ", known only" : "";
  return `$${(knownCreditTotal(racers) / 100).toFixed(2)}${suffix}`;
}

// Short per-1M-token rate label for the task card, e.g. "$2.5/$15 per 1M".
function rateLabel(p?: Pricing): string {
  if (!p) return "unpriced";
  const f = (x: number) => (Number.isInteger(x) ? `$${x}` : `$${x}`);
  return `${f(p.input)}/${f(p.output)} per 1M`;
}

// ----------------------------------------------------------------------------
// Per-racer state
// ----------------------------------------------------------------------------
interface Racer {
  query: string;
  model: ModelInfo;
  tier: "fast" | "frontier";
  pricing?: Pricing;
  color: string;
  startAt: number;
  firstTokenAt?: number;
  endAt?: number;
  apiDurationMs: number;
  text: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  apiCalls: number;
  status: "running" | "done" | "error";
  error?: string;
}

const totalTokens = (r: Racer): number => r.inputTokens + r.outputTokens;

// ----------------------------------------------------------------------------
// Terminal helpers
// ----------------------------------------------------------------------------
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};
const PALETTE = [C.cyan, C.magenta, C.yellow, C.green, C.blue, C.red];

function visibleLen(s: string): number {
  const stripped = s.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of stripped) {
    const cp = ch.codePointAt(0)!;
    // Treat emoji / symbols that render double-width in terminals as 2 columns.
    w += cp === 0x26a1 || cp >= 0x1f300 ? 2 : 1;
  }
  return w;
}
function padR(s: string, width: number): string {
  const len = visibleLen(s);
  if (len > width) {
    const raw = s.replace(/\x1b\[[0-9;]*m/g, "");
    return raw.slice(0, Math.max(0, width - 1)) + "\u2026";
  }
  return s + " ".repeat(width - len);
}
function padL(s: string, width: number): string {
  const len = visibleLen(s);
  if (len >= width) return s;
  return " ".repeat(width - len) + s;
}
function fmtMs(ms?: number): string {
  if (ms === undefined || ms === null) return "\u2013";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

function wrapPlain(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur.length === 0) cur = w;
    else if ((cur + " " + w).length <= width) cur += " " + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// ----------------------------------------------------------------------------
// Task card (printed once at the start)
// ----------------------------------------------------------------------------
function printTaskCard(racers: Racer[], prompt: string, config: RaceConfig): void {
  const W = 74;
  const inner = W - 4;
  const top = `${C.magenta}\u256d${"\u2500".repeat(W - 2)}\u256e${C.reset}`;
  const bot = `${C.magenta}\u2570${"\u2500".repeat(W - 2)}\u256f${C.reset}`;
  const bar = `${C.magenta}\u2502${C.reset}`;
  const row = (content: string) =>
    `${bar} ${content}${" ".repeat(Math.max(0, inner - visibleLen(content)))} ${bar}`;
  const sep = `${C.magenta}\u251c${"\u2500".repeat(W - 2)}\u2524${C.reset}`;

  process.stdout.write(top + "\n");
  process.stdout.write(row(`${C.bold}${C.magenta}\u26a1 Copilot SDK Model Race${C.reset}`) + "\n");
  process.stdout.write(sep + "\n");
  process.stdout.write(row(`${C.dim}Task${C.reset}`) + "\n");
  for (const l of wrapPlain(prompt, inner - 2)) process.stdout.write(row(`  ${l}`) + "\n");
  process.stdout.write(row("") + "\n");
  process.stdout.write(row(`${C.dim}Models (${racers.length})${C.reset}`) + "\n");
  for (const r of racers) {
    const tag = r.tier === "frontier" ? `${C.gray}frontier ref${C.reset}` : `${C.gray}fast${C.reset}`;
    process.stdout.write(
      row(`  ${r.color}\u25cf${C.reset} ${r.model.name}  ${tag}  ${C.gray}${rateLabel(r.pricing)}${C.reset}`) + "\n",
    );
  }
  process.stdout.write(row("") + "\n");
  process.stdout.write(
    row(`${C.dim}Mode${C.reset}  single-shot \u00b7 tools disabled \u00b7 concurrent, same prompt`) + "\n",
  );
  process.stdout.write(row(`${C.dim}Metric${C.reset}  speed \u00b7 token spend \u00b7 AI credits (token-based)`) + "\n");
  process.stdout.write(
    row(`${C.dim}Cost${C.reset}  ${C.gray}best-case floor \u2014 agentic CLI (tools/MCP/multi-turn) costs more${C.reset}`) + "\n",
  );
  if (config.judgeEnabled) {
    process.stdout.write(
      row(`${C.dim}Review${C.reset}  blind LLM-as-judge \u00b7 ${config.judgeQuery}`) + "\n",
    );
    process.stdout.write(
      row(`        ${C.gray}anonymized \u00b7 scores correctness/completeness/quality${C.reset}`) + "\n",
    );
  } else {
    process.stdout.write(
      row(`${C.dim}Review${C.reset}  ${C.gray}disabled (--no-judge)${C.reset}`) + "\n",
    );
  }
  process.stdout.write(bot + "\n\n");
}

// ----------------------------------------------------------------------------
// Live leaderboard renderer (scales to N rows)
// ----------------------------------------------------------------------------
class Renderer {
  private painted = false;
  private lastHeight = 0;
  private W = { name: 24, elapsed: 8, gen: 8, in: 9, out: 8, total: 9, tps: 7, cost: 8 };

  constructor(private racers: Racer[], private prompt: string) {}

  private headerRow(): string {
    const W = this.W;
    return (
      `${C.dim}  ` +
      padR("MODEL", W.name) +
      padL("ELAPSED", W.elapsed) +
      padL("GEN", W.gen) +
      padL("IN TOK", W.in) +
      padL("OUT TOK", W.out) +
      padL("TOTAL", W.total) +
      padL("TOK/S", W.tps) +
      padL("AI CRED", W.cost) +
      `${C.reset}`
    );
  }

  private row(r: Racer): string {
    const W = this.W;
    const now = Date.now();
    const dot =
      r.status === "running"
        ? `${C.yellow}\u25cf${C.reset}`
        : r.status === "done"
          ? `${C.green}\u25cf${C.reset}`
          : `${C.red}\u25cf${C.reset}`;
    const elapsed = (r.endAt ?? now) - r.startAt;
    const genS = (r.apiDurationMs || elapsed) / 1000;
    const tps = r.outputTokens && genS > 0 ? Math.round(r.outputTokens / genS) : 0;
    const tierTag = r.tier === "frontier" ? `${C.gray}\u00b7ref${C.reset}` : "";
    const name = `${r.color}${r.model.name}${C.reset}${tierTag}`;
    return (
      `${dot} ` +
      padR(name, W.name) +
      padL(fmtMs(elapsed), W.elapsed) +
      padL(fmtMs(r.apiDurationMs || undefined), W.gen) +
      padL(fmtInt(r.inputTokens), W.in) +
      padL(fmtInt(r.outputTokens), W.out) +
      padL(`${C.bold}${fmtInt(totalTokens(r))}${C.reset}`, W.total) +
      padL(String(tps), W.tps) +
      padL(fmtCredits(aiCredits(r)), W.cost)
    );
  }

  render(final = false): void {
    const lines: string[] = [];
    lines.push(
      `${C.bold}${C.magenta}\u26a1 Copilot SDK Model Race${C.reset}  ${C.dim}\u2014 ${this.racers.length} models, same prompt, concurrent${C.reset}`,
    );
    lines.push(`${C.dim}Prompt:${C.reset} ${padR(this.prompt, 86)}`);
    lines.push("");
    lines.push(this.headerRow());
    this.racers.forEach((r) => lines.push(this.row(r)));

    const totIn = this.racers.reduce((a, r) => a + r.inputTokens, 0);
    const totOut = this.racers.reduce((a, r) => a + r.outputTokens, 0);
    lines.push(`${C.gray}${"\u2500".repeat(80)}${C.reset}`);
    lines.push(
      `${C.dim}Token spend:${C.reset} ${C.bold}${fmtInt(totIn + totOut)}${C.reset} ` +
        `${C.dim}(in ${fmtInt(totIn)} / out ${fmtInt(totOut)})${C.reset}   ` +
        `${C.dim}AI credits:${C.reset} ${C.bold}${fmtCreditTotal(this.racers)}${C.reset} ${C.dim}(\u2248 ${fmtCreditDollarTotal(this.racers)}, est.)${C.reset}`,
    );

    // Reposition to overwrite the previously painted frame. We do this for the
    // final frame too, so the last live frame is replaced in place rather than
    // a duplicate table being appended below it (TTY animation path).
    if (this.painted) process.stdout.write(`\x1b[${this.lastHeight}A`);
    process.stdout.write(lines.map((l) => `\x1b[2K${l}`).join("\n") + "\n");
    this.lastHeight = lines.length;
    this.painted = true;
  }
}

// ----------------------------------------------------------------------------
// Run one racer
// ----------------------------------------------------------------------------
async function runRacer(
  client: CopilotClient,
  racer: Racer,
  prompt: string,
  onUpdate: () => void,
): Promise<void> {
  const session = await client.createSession({
    clientName: "model-race-demo",
    model: racer.model.id,
    onPermissionRequest: approveAll,
  });

  racer.startAt = Date.now();

  session.on((event: SessionEvent) => {
    switch (event.type) {
      case "assistant.message_start":
      case "assistant.streaming_delta":
      case "assistant.reasoning_delta": {
        if (racer.firstTokenAt === undefined) {
          racer.firstTokenAt = Date.now();
          onUpdate();
        }
        break;
      }
      case "assistant.message_delta": {
        if (racer.firstTokenAt === undefined) racer.firstTokenAt = Date.now();
        racer.text += event.data.deltaContent;
        onUpdate();
        break;
      }
      case "assistant.usage": {
        const d = event.data;
        racer.inputTokens += d.inputTokens ?? 0;
        racer.outputTokens += d.outputTokens ?? 0;
        racer.cost += d.cost ?? 0;
        racer.apiDurationMs += d.duration ?? 0;
        racer.apiCalls += 1;
        if (racer.firstTokenAt === undefined && d.timeToFirstTokenMs)
          racer.firstTokenAt = racer.startAt + d.timeToFirstTokenMs;
        onUpdate();
        break;
      }
      case "session.error": {
        racer.status = "error";
        racer.error = (event as any).data?.message ?? "unknown error";
        onUpdate();
        break;
      }
    }
  });

  try {
    const final = await session.sendAndWait(prompt, 180_000);
    racer.endAt = Date.now();
    if (!racer.text && final?.data?.content) racer.text = final.data.content;
    if (racer.status !== "error") racer.status = "done";
  } catch (err) {
    racer.endAt = Date.now();
    racer.status = "error";
    racer.error = err instanceof Error ? err.message : String(err);
  } finally {
    onUpdate();
    await session.disconnect().catch(() => {});
  }
}

// ----------------------------------------------------------------------------
// Summary
// ----------------------------------------------------------------------------
function line(s = "") {
  process.stdout.write(s + "\n");
}

function table(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) =>
    Math.max(visibleLen(h), ...rows.map((r) => visibleLen(r[i] ?? ""))),
  );
  const fmtRow = (cells: string[]) =>
    "  " +
    cells.map((c, i) => (i === 0 ? padR(c, widths[i]) : padL(c, widths[i]))).join("  ");
  line(fmtRow(headers.map((h) => `${C.dim}${h}${C.reset}`)));
  line("  " + widths.map((w) => "\u2500".repeat(w)).join("  "));
  for (const r of rows) line(fmtRow(r));
}

function printSummary(racers: Racer[]): void {
  const done = racers.filter((r) => r.status === "done");

  line();
  line(`${C.bold}${C.magenta}\u2550\u2550 Leaderboard (sorted by token spend) \u2550\u2550${C.reset}`);
  line();

  const byTokens = [...racers].sort((a, b) => totalTokens(a) - totalTokens(b));
  table(
    ["Model", "Tier", "Time", "Gen(API)", "In tok", "Out tok", "Total tok", "Tok/s", "AI cred", "Status"],
    byTokens.map((r) => {
      const wall = (r.endAt ?? Date.now()) - r.startAt;
      const genS = (r.apiDurationMs || wall) / 1000;
      const tps = r.outputTokens && genS > 0 ? Math.round(r.outputTokens / genS) : 0;
      return [
        `${r.color}${r.model.name}${C.reset}`,
        r.tier === "frontier" ? `${C.gray}frontier${C.reset}` : "fast",
        fmtMs(wall),
        fmtMs(r.apiDurationMs || undefined),
        fmtInt(r.inputTokens),
        fmtInt(r.outputTokens),
        `${C.bold}${fmtInt(totalTokens(r))}${C.reset}`,
        String(tps),
        fmtCredits(aiCredits(r)),
        r.status === "error" ? `${C.red}error${C.reset}` : r.status,
      ];
    }),
  );

  const totIn = racers.reduce((a, r) => a + r.inputTokens, 0);
  const totOut = racers.reduce((a, r) => a + r.outputTokens, 0);
  line();
  line(`${C.bold}${C.cyan}\u2550\u2550 Token spend & cost \u2550\u2550${C.reset}`);
  line(
    `  ${C.dim}Total tokens across all models:${C.reset} ${C.bold}${fmtInt(totIn + totOut)}${C.reset}` +
      `  ${C.dim}(input ${fmtInt(totIn)} / output ${fmtInt(totOut)})${C.reset}`,
  );
  line(
    `  ${C.dim}Total AI credits:${C.reset} ${C.bold}${fmtCreditTotal(racers)}${C.reset}` +
      `  ${C.dim}(\u2248 ${fmtCreditDollarTotal(racers)} \u00b7 1 credit = $0.01)${C.reset}`,
  );
  line(
    `  ${C.gray}est. \u2014 default tier, input+output tokens only; excludes cached-input/cache-write discounts.${C.reset}`,
  );
  const missingPricing = racers.filter((r) => !r.pricing);
  if (missingPricing.length) {
    line(
      `  ${C.gray}unpriced: ${missingPricing.map((r) => r.model.name).join(", ")} \u2014 not in local pricing table; credit total is partial.${C.reset}`,
    );
  }

  if (done.length >= 2) {
    line();
    line(`${C.bold}${C.magenta}\u2550\u2550 Verdicts \u2550\u2550${C.reset}`);
    const fastest = [...done].sort((a, b) => a.endAt! - a.startAt - (b.endAt! - b.startAt))[0];
    const slowest = [...done].sort((a, b) => b.endAt! - b.startAt - (a.endAt! - a.startAt))[0];
    const tf = fastest.endAt! - fastest.startAt;
    const ts = slowest.endAt! - slowest.startAt;
    line(
      `  ${C.green}\u{1f3c1} Fastest:${C.reset} ${C.bold}${fastest.model.name}${C.reset}` +
        ` ${C.dim}(${(ts / tf).toFixed(2)}\u00d7 faster than slowest, ${slowest.model.name})${C.reset}`,
    );
    const leanest = [...done].sort((a, b) => totalTokens(a) - totalTokens(b))[0];
    const heaviest = [...done].sort((a, b) => totalTokens(b) - totalTokens(a))[0];
    line(
      `  ${C.cyan}\u{1fab6} Fewest tokens:${C.reset} ${C.bold}${leanest.model.name}${C.reset}` +
        ` ${C.dim}(${fmtInt(totalTokens(leanest))} vs ${fmtInt(totalTokens(heaviest))} for ${heaviest.model.name})${C.reset}`,
    );
    const bestTps = [...done]
      .map((r) => {
        const genS = (r.apiDurationMs || r.endAt! - r.startAt) / 1000;
        return { r, tps: r.outputTokens && genS > 0 ? r.outputTokens / genS : 0 };
      })
      .sort((a, b) => b.tps - a.tps)[0];
    line(
      `  ${C.yellow}\u26a1 Highest throughput:${C.reset} ${C.bold}${bestTps.r.model.name}${C.reset}` +
        ` ${C.dim}(${Math.round(bestTps.tps)} output tok/s)${C.reset}`,
    );
    const priced = done.filter((r) => aiCredits(r) !== undefined);
    if (priced.length >= 2) {
      const cheapest = [...priced].sort((a, b) => aiCredits(a)! - aiCredits(b)!)[0];
      const dearest = [...priced].sort((a, b) => aiCredits(b)! - aiCredits(a)!)[0];
      line(
        `  ${C.green}\u{1f4b0} Lowest AI-credit cost:${C.reset} ${C.bold}${cheapest.model.name}${C.reset}` +
          ` ${C.dim}(${fmtCredits(aiCredits(cheapest))} cr vs ${fmtCredits(aiCredits(dearest))} cr for ${dearest.model.name})${C.reset}`,
      );
    }
  }

  const errored = racers.filter((r) => r.status === "error");
  if (errored.length) {
    line();
    for (const r of errored) line(`  ${C.red}\u2717 ${r.model.name}: ${r.error}${C.reset}`);
  }
  line();
  line(
    `${C.dim}AI credits: GitHub Docs \u201cModels and pricing for GitHub Copilot\u201d (${PRICING_REFERENCE_URL}) ` +
      `(token-based billing,` +
      ` Business/Enterprise). 1 AI credit = $0.01; cost = (input+output tokens \u00d7 per-model rate).` +
      ` Single-shot with tools disabled \u2014 agentic CLI runs (tools/MCP/multi-turn) cost more because` +
      ` context is re-sent each turn. The legacy per-request multiplier is obsolete for these plans.${C.reset}`,
  );
  line();
}

// ----------------------------------------------------------------------------
// Quality review (LLM-as-judge)
// ----------------------------------------------------------------------------
interface QualityScore {
  correctness: number;
  completeness: number;
  codeQuality: number;
  overall: number;
  note: string;
}

function extractJsonArray(text: string): any[] | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

async function runJudge(
  client: CopilotClient,
  judge: ModelInfo,
  task: string,
  racers: Racer[],
): Promise<Map<Racer, QualityScore>> {
  const contestants = racers.filter((r) => r.status === "done" && r.text.trim().length > 0);
  const scores = new Map<Racer, QualityScore>();
  if (contestants.length === 0) return scores;

  // Anonymize + shuffle to reduce position/identity bias.
  const order = [...contestants];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  // Pack each full answer into the judge prompt. Truncating too aggressively
  // here biases against thorough models: longer, more complete solutions (often
  // the frontier ones) get chopped mid-code and the judge then scores them as
  // "truncated / syntactically invalid". Give each candidate a generous budget
  // that scales down only when the lineup is large, so the judge always sees a
  // syntactically complete solution. ~120k chars total ≈ 30k tokens, well within
  // a frontier judge's context window.
  const perCandidateChars = Math.max(8000, Math.floor(120_000 / order.length));
  const candidateBlocks = order
    .map((r, i) => {
      const full = r.text.trim();
      const body =
        full.length > perCandidateChars
          ? full.slice(0, perCandidateChars) + "\n[...truncated for length...]"
          : full;
      return `--- Candidate ${i + 1} ---\n${body}`;
    })
    .join("\n\n");

  const judgePrompt =
    `You are an expert, impartial code reviewer. A coding TASK was given to ${order.length} ` +
    `anonymous AI models. Score each candidate solution strictly on the merits of its code.\n\n` +
    `TASK:\n${task}\n\n` +
    `Score each candidate from 0-10 on:\n` +
    `- correctness: does the code actually solve the task correctly?\n` +
    `- completeness: does it include everything asked (e.g. the required tests)?\n` +
    `- codeQuality: readability, idiomatic style, edge-case handling.\n` +
    `Then give an overall 0-10. Be discerning; do not give everything the same score.\n\n` +
    `Return ONLY a JSON array, no prose, no markdown fences, in this exact shape:\n` +
    `[{"candidate":1,"correctness":0,"completeness":0,"codeQuality":0,"overall":0,"note":"one short sentence"}]\n\n` +
    `CANDIDATES:\n${candidateBlocks}`;

  const session = await client.createSession({
    clientName: "model-race-judge",
    model: judge.id,
    onPermissionRequest: approveAll,
  });
  try {
    const res = await session.sendAndWait(judgePrompt, 180_000);
    const parsed = extractJsonArray(res?.data?.content ?? "");
    if (!parsed) return scores;
    for (const entry of parsed) {
      const idx = Number(entry.candidate) - 1;
      if (idx < 0 || idx >= order.length) continue;
      scores.set(order[idx], {
        correctness: Number(entry.correctness) || 0,
        completeness: Number(entry.completeness) || 0,
        codeQuality: Number(entry.codeQuality) || 0,
        overall: Number(entry.overall) || 0,
        note: String(entry.note ?? "").slice(0, 80),
      });
    }
  } finally {
    await session.disconnect().catch(() => {});
  }
  return scores;
}

function printQuality(
  racers: Racer[],
  scores: Map<Racer, QualityScore>,
  judge: ModelInfo,
): void {
  if (scores.size === 0) {
    line(`${C.dim}Quality review produced no parseable scores; skipping.${C.reset}`);
    line();
    return;
  }
  line(`${C.bold}${C.cyan}\u2550\u2550 Quality review \u2550\u2550${C.reset}  ${C.dim}judge: ${judge.name} (anonymized, blind)${C.reset}`);
  line();

  const ranked = [...scores.entries()].sort((a, b) => b[1].overall - a[1].overall);
  table(
    ["Model", "Correct", "Complete", "Quality", "Overall", "AI cred", "Qual/Cr", "Note"],
    ranked.map(([r, s]) => {
      const cred = aiCredits(r);
      const valueRatio = cred && cred > 0 ? (s.overall / cred).toFixed(1) : "\u2013";
      return [
        `${r.color}${r.model.name}${C.reset}`,
        s.correctness.toFixed(0),
        s.completeness.toFixed(0),
        s.codeQuality.toFixed(0),
        `${C.bold}${s.overall.toFixed(0)}${C.reset}`,
        fmtCredits(cred),
        valueRatio,
        `${C.dim}${s.note}${C.reset}`,
      ];
    }),
  );

  line();
  const best = ranked[0];
  line(`  ${C.green}\u2b50 Highest quality:${C.reset} ${C.bold}${best[0].model.name}${C.reset} ${C.dim}(${best[1].overall.toFixed(0)}/10)${C.reset}`);
  const valued = ranked
    .filter(([r]) => {
      const c = aiCredits(r);
      return c !== undefined && c > 0;
    })
    .map(([r, s]) => ({ r, ratio: s.overall / aiCredits(r)! }))
    .sort((a, b) => b.ratio - a.ratio)[0];
  if (valued)
    line(
      `  ${C.yellow}\u{1f4b8} Best quality-per-cost:${C.reset} ${C.bold}${valued.r.model.name}${C.reset}` +
        ` ${C.dim}(${valued.ratio.toFixed(1)} quality points per AI credit)${C.reset}`,
    );
  line();
  line(
    `${C.dim}Quality is a single blind LLM-as-judge pass; scores are directional, not definitive.` +
      ` Run multiple times or use a human reviewer for high-stakes claims.${C.reset}`,
  );
  line();
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
async function main() {
  process.stdout.write(`${C.dim}Starting Copilot SDK and resolving models\u2026${C.reset}\n`);

  const client = new CopilotClient({ clientName: "model-race-demo" } as any);
  await client.start();

  let models: ModelInfo[];
  try {
    models = await client.listModels();
  } catch {
    process.stderr.write(
      `${C.red}Failed to list models. Are you signed in to Copilot? (run \`copilot\` once to authenticate)${C.reset}\n`,
    );
    await client.stop();
    process.exitCode = 1;
    return;
  }

  const raceConfig = await setupRaceConfig(args, models);
  const fullPrompt = raceConfig.userPrompt + PROMPT_GUARDRAIL;

  let racers: Racer[];
  try {
    const seen = new Set<string>();
    const resolved: Array<{ query: string; model: ModelInfo }> = [];
    for (const q of raceConfig.modelQueries) {
      const m = resolveModel(models, q);
      if (!seen.has(m.id)) {
        seen.add(m.id);
        resolved.push({ query: q, model: m });
      }
    }
    racers = resolved.map(({ query, model }, i) => ({
      query,
      model,
      tier: tierOf(model),
      pricing: pricingFor(model),
      color: PALETTE[i % PALETTE.length],
      startAt: Date.now(),
      text: "",
      apiDurationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      apiCalls: 0,
      status: "running",
    }));
  } catch (err) {
    process.stderr.write(`${C.red}${err instanceof Error ? err.message : String(err)}${C.reset}\n`);
    await client.stop();
    process.exitCode = 1;
    return;
  }

  const renderer = new Renderer(racers, raceConfig.userPrompt);
  printTaskCard(racers, raceConfig.userPrompt, raceConfig);
  let dirty = true;
  const onUpdate = () => {
    dirty = true;
  };
  let timer: NodeJS.Timeout | undefined;
  if (streamLive) {
    renderer.render();
    timer = setInterval(() => {
      if (dirty) {
        renderer.render();
        dirty = false;
      }
    }, 80);
  } else {
    process.stdout.write(
      `${C.dim}Racing ${racers.map((r) => r.model.name).join(", ")} \u2026${C.reset}\n`,
    );
  }

  // Run ALL models at the same time.
  await Promise.all(racers.map((r) => runRacer(client, r, fullPrompt, onUpdate)));

  if (timer) clearInterval(timer);
  if (showTable) renderer.render(true);

  printSummary(racers);

  if (raceConfig.judgeEnabled) {
    let judge: ModelInfo | undefined;
    try {
      judge = resolveModel(models, raceConfig.judgeQuery);
    } catch {
      line(`${C.dim}Quality review skipped: judge model "${raceConfig.judgeQuery}" not available.${C.reset}\n`);
    }
    if (judge) {
      process.stdout.write(`${C.dim}Running blind quality review with ${judge.name}\u2026${C.reset}\n`);
      try {
        const scores = await runJudge(client, judge, raceConfig.userPrompt, racers);
        printQuality(racers, scores, judge);
      } catch (err) {
        line(
          `${C.dim}Quality review failed: ${err instanceof Error ? err.message : String(err)}${C.reset}\n`,
        );
      }
    }
  }

  await client.stop();
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(
      `\n${C.red}Fatal: ${err instanceof Error ? err.stack : String(err)}${C.reset}\n`,
    );
    process.exitCode = 1;
  });
}
