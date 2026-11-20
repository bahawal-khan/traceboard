/**
 * Server-side cost (the client never sends a cost). Pure and driver-agnostic: prices arrive as
 * decimal STRINGS (`numeric` columns) and the arithmetic is integer BigInt, so there is no float
 * noise. USD per 1M tokens equals micro-USD per token, so micro = tokens * price.
 *
 * Not modelled yet (docs/PHASES.md "Carried forward"): long-context price tiers and cache-WRITE
 * prices. Very long prompts are under-costed until they are.
 */
export type ModelPrice = {
  model: string;
  inputPer1m: string;
  outputPer1m: string;
  /** Cache READ price; null means cached tokens are billed at the input price. */
  cachedInputPer1m: string | null;
};

const SCALE = BigInt(1_000_000); // price fractional digits kept (the seed allows at most 6)

/** "8.00" -> 8_000_000n. Throws on anything but a plain decimal with at most 6 places. */
export function parsePrice(p: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(p);
  if (!m) throw new Error("invalid price");
  return BigInt(m[1]!) * SCALE + BigInt((m[2] ?? "").padEnd(6, "0"));
}

type Scaled = { input: bigint; output: bigint; cached: bigint };

/**
 * Cost in integer micro-USD, rounded half up. `inputTokens` is the TOTAL prompt tokens and
 * `cachedTokens` the cached subset of it (clamped to the total).
 */
export function costMicro(price: ModelPrice, inputTokens: number, outputTokens: number, cachedTokens = 0): number {
  return costMicroScaled(scalePrice(price), inputTokens, outputTokens, cachedTokens);
}

function scalePrice(p: ModelPrice): Scaled {
  const input = parsePrice(p.inputPer1m);
  return { input, output: parsePrice(p.outputPer1m), cached: p.cachedInputPer1m === null ? input : parsePrice(p.cachedInputPer1m) };
}

function costMicroScaled(s: Scaled, inputTokens: number, outputTokens: number, cachedTokens: number): number {
  const cached = Math.min(Math.max(cachedTokens, 0), inputTokens);
  const fresh = inputTokens - cached;
  const scaled = BigInt(fresh) * s.input + BigInt(cached) * s.cached + BigInt(outputTokens) * s.output;
  return Number((scaled + SCALE / BigInt(2)) / SCALE);
}

/** numeric(12,6) text for `events.cost_usd`: micro-USD is exactly six decimal places. */
export function microToUsdString(micro: number): string {
  const whole = Math.trunc(micro / 1_000_000);
  const frac = String(micro % 1_000_000).padStart(6, "0");
  return `${whole}.${frac}`;
}

const DATE_SUFFIX = /^(.+)-(\d{4})-?(\d{2})-?(\d{2})$/;

/** "gpt-4o-2024-08-06" -> "gpt-4o"; null when there is no real trailing date. Mixed forms like 2024-0806 do not count. */
export function stripDateSuffix(id: string): string | null {
  const m = DATE_SUFFIX.exec(id);
  if (!m) return null;
  const dashed = /-\d{4}-\d{2}-\d{2}$/.test(id);
  const compact = /-\d{8}$/.test(id);
  if (!dashed && !compact) return null;
  const [y, mo, d] = [Number(m[2]), Number(m[3]), Number(m[4])];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1) return null;
  if (d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
  return m[1]!;
}

export type PriceLoader = () => Promise<readonly ModelPrice[]>;

/**
 * Per-instance price cache. `loader` is injected (the DB read lives in a repo module, not here), and
 * a failed refresh keeps serving the last good list, so a Neon hiccup never breaks ingest.
 * Lookups are by exact model id; an unknown model has no cost (null), never a guess.
 */
export class PriceBook {
  private byModel = new Map<string, Scaled>();
  private loadedAt = -Infinity;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly loader: PriceLoader,
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  private refresh(): Promise<void> {
    this.inflight ??= this.loader()
      .then((rows) => {
        const next = new Map<string, Scaled>();
        for (const r of rows) next.set(r.model, scalePrice(r));
        this.byModel = next;
        this.loadedAt = this.now();
      })
      .catch(() => {
        // Keep the old list. Retry on the next call after a short back-off, not on every event.
        this.loadedAt = Math.max(this.loadedAt, this.now() - this.ttlMs + 30_000);
        if (this.byModel.size === 0) throw new Error("price list unavailable");
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  async ready(): Promise<void> {
    if (this.now() - this.loadedAt >= this.ttlMs) await this.refresh();
  }

  /**
   * Exact (case-insensitive) match first. Only if that fails, strip ONE trailing date suffix
   * (-YYYY-MM-DD or -YYYYMMDD, and only if it is a real calendar date) and retry. No prefix or
   * fuzzy matching: a wrong price is worse than no price.
   */
  private lookup(model: string): Scaled | undefined {
    const id = model.toLowerCase();
    const exact = this.byModel.get(id);
    if (exact) return exact;
    const base = stripDateSuffix(id);
    return base === null ? undefined : this.byModel.get(base);
  }

  /** Call after `ready()`. Null when the model is unknown or has no token counts. */
  cost(model: string | undefined, inputTokens: number | undefined, outputTokens: number | undefined, cachedTokens?: number): number | null {
    if (!model || (inputTokens === undefined && outputTokens === undefined)) return null;
    const s = this.lookup(model);
    if (!s) return null;
    return costMicroScaled(s, inputTokens ?? 0, outputTokens ?? 0, cachedTokens ?? 0);
  }
}
