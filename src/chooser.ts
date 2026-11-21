// Every nondeterministic decision of the simulation goes through Chooser.choose and is recorded (ADR D2).
import { SplitMix64 } from './rng.ts';

/** Matches replay_case.recorded_choices: message delivery delay, same-step order, node processing order. */
export type ChoiceKind = 'delay' | 'delivery-order' | 'node-order' | 'client-order';
export type Option = number | string;

export interface ChoiceContext {
  readonly tick: number;
  readonly from?: string;
  readonly to?: string;
}

export interface ChoiceRecord {
  readonly tick: number;
  readonly kind: ChoiceKind;
  readonly options: readonly Option[];
  readonly value: Option;
}

export type Strategy =
  | { readonly type: 'min' }
  | { readonly type: 'max' }
  | { readonly type: 'seed'; readonly seed: number }
  | { readonly type: 'per-destination'; readonly delays: Readonly<Record<string, number>> }
  | { readonly type: 'function'; readonly name: string; readonly pick: (kind: ChoiceKind, options: readonly Option[], ctx: ChoiceContext) => Option };

export function strategyName(s: Strategy): string {
  switch (s.type) {
    case 'min':
    case 'max':
      return s.type;
    case 'seed':
      return `seed:${s.seed}`;
    case 'per-destination':
      return `dest:${Object.entries(s.delays).map(([k, v]) => `${k}${v}`).join('')}`;
    case 'function':
      return `fn:${s.name}`;
  }
}

export interface Chooser {
  choose<T extends Option>(kind: ChoiceKind, options: readonly T[], ctx: ChoiceContext): T;
  /** Choices recorded so far, in call order. */
  readonly records: readonly ChoiceRecord[];
}

/** Orders `items` by repeatedly choosing among the remaining ones. */
export function choosePermutation<T>(chooser: Chooser, kind: ChoiceKind, items: readonly T[], idOf: (t: T) => string, ctx: ChoiceContext): T[] {
  const remaining = [...items];
  const out: T[] = [];
  while (remaining.length > 0) {
    const id = chooser.choose(kind, remaining.map(idOf), ctx);
    const i = remaining.findIndex((t) => idOf(t) === id);
    out.push(...remaining.splice(i, 1));
  }
  return out;
}

export class StrategyChooser implements Chooser {
  readonly records: ChoiceRecord[] = [];
  private readonly rng: SplitMix64 | null;
  readonly strategy: Strategy;

  constructor(strategy: Strategy) {
    this.strategy = strategy;
    this.rng = strategy.type === 'seed' ? new SplitMix64(strategy.seed) : null;
  }

  choose<T extends Option>(kind: ChoiceKind, options: readonly T[], ctx: ChoiceContext): T {
    if (options.length === 0) throw new Error(`choose(${kind}): no options`);
    if (options.length === 1) return options[0] as T;
    const value = this.pick(kind, options, ctx);
    if (!options.includes(value)) throw new Error(`strategy picked ${String(value)} outside options`);
    this.records.push({ tick: ctx.tick, kind, options: [...options], value });
    return value;
  }

  private pick<T extends Option>(kind: ChoiceKind, options: readonly T[], ctx: ChoiceContext): T {
    const s = this.strategy;
    switch (s.type) {
      case 'min':
        return kind === 'delay' ? (Math.min(...(options as readonly number[])) as T) : (options[0] as T);
      case 'max':
        return kind === 'delay' ? (Math.max(...(options as readonly number[])) as T) : (options[options.length - 1] as T);
      case 'seed':
        return options[(this.rng as SplitMix64).nextInt(options.length)] as T;
      case 'per-destination': {
        if (kind === 'delay' && ctx.to !== undefined && s.delays[ctx.to] !== undefined) {
          const d = s.delays[ctx.to] as number;
          if ((options as readonly Option[]).includes(d)) return d as T;
        }
        return kind === 'delay' ? (Math.min(...(options as readonly number[])) as T) : (options[0] as T);
      }
      case 'function':
        return s.pick(kind, options, ctx) as T;
    }
  }
}

export class ReplayMismatch extends Error {}

/** Takes values only from a recorded choice log; any deviation throws (ADR D2). */
export class ReplayChooser implements Chooser {
  readonly records: ChoiceRecord[] = [];
  private index = 0;
  private readonly source: readonly ChoiceRecord[];

  constructor(source: readonly ChoiceRecord[]) {
    this.source = source;
  }

  get remaining(): number {
    return this.source.length - this.index;
  }

  choose<T extends Option>(kind: ChoiceKind, options: readonly T[], ctx: ChoiceContext): T {
    if (options.length === 0) throw new Error(`choose(${kind}): no options`);
    if (options.length === 1) return options[0] as T;
    const rec = this.source[this.index];
    if (rec === undefined) throw new ReplayMismatch(`replay: no recorded choice left for ${kind} at tick ${ctx.tick}`);
    if (rec.kind !== kind || rec.tick !== ctx.tick || rec.options.length !== options.length || rec.options.some((o, i) => o !== options[i])) {
      throw new ReplayMismatch(
        `replay: choice #${this.index} mismatch: recorded ${rec.kind}@${rec.tick} ${JSON.stringify(rec.options)}, requested ${kind}@${ctx.tick} ${JSON.stringify(options)}`,
      );
    }
    this.index++;
    this.records.push(rec);
    return rec.value as T;
  }
}

/** Replays recorded choices up to and including `atTick`, then draws from a new strategy (ADR D11 branch). */
export class BranchChooser implements Chooser {
  readonly records: ChoiceRecord[] = [];
  private readonly replay: ReplayChooser;
  private readonly fresh: StrategyChooser;
  private readonly atTick: number;

  constructor(prefix: readonly ChoiceRecord[], atTick: number, strategy: Strategy) {
    this.replay = new ReplayChooser(prefix);
    this.fresh = new StrategyChooser(strategy);
    this.atTick = atTick;
  }

  get prefixRemaining(): number {
    return this.replay.remaining;
  }

  choose<T extends Option>(kind: ChoiceKind, options: readonly T[], ctx: ChoiceContext): T {
    if (options.length <= 1) return this.replay.choose(kind, options, ctx);
    const value = ctx.tick <= this.atTick ? this.replay.choose(kind, options, ctx) : this.fresh.choose(kind, options, ctx);
    this.records.push({ tick: ctx.tick, kind, options: [...options], value });
    return value;
  }
}
