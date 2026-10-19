/**
 * What a Claude model's request surface accepts, keyed off its ID. Every LLM
 * call site builds its params from this instead of sniffing `includes("haiku")`
 * — that test was right for Haiku 4.5 and wrong for Haiku 5.5, which takes
 * effort but 400s on `temperature`.
 */
export type ModelCapabilities = {
  /** `output_config.effort`. Haiku 4.5 and older reject it. */
  effort: boolean;
  /** Non-default `temperature`. Removed on Haiku 5.5, Sonnet 5+, Opus 4.7+, Fable. */
  temperature: boolean;
  /** `web_search_20260209` (dynamic filtering) — Opus 4.6+ and Sonnet 4.6+ only;
   *  everything else gets the basic `web_search_20250305`. */
  dynamicWebSearch: boolean;
  /** Adaptive thinking runs when `thinking` is omitted, so thinking tokens count
   *  against `max_tokens` — callers must leave headroom above the answer size. */
  thinksByDefault: boolean;
};

const LEGACY = /^claude-(3|haiku-4|sonnet-4-5|opus-4-5|opus-4-1|opus-4-0|sonnet-4-0)/;

export function modelCapabilities(model: string): ModelCapabilities {
  const legacy = LEGACY.test(model);
  const v46 = /^claude-(opus|sonnet)-4-6/.test(model);
  const v47or48 = /^claude-opus-4-[78]/.test(model);
  return {
    effort: !legacy,
    temperature: legacy || v46,
    dynamicWebSearch: /^claude-(opus|sonnet)-/.test(model) && !legacy,
    thinksByDefault: !legacy && !v46 && !v47or48,
  };
}
