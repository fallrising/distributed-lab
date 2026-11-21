// splitmix64: the only source of pseudo-randomness. Every draw goes through a Chooser and is recorded (ADR D2).
const MASK = 64;

export class SplitMix64 {
  private state: bigint;

  constructor(seed: number | bigint) {
    this.state = BigInt.asUintN(MASK, BigInt(seed));
  }

  next(): bigint {
    this.state = BigInt.asUintN(MASK, this.state + 0x9e3779b97f4a7c15n);
    let z = this.state;
    z = BigInt.asUintN(MASK, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
    z = BigInt.asUintN(MASK, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
    return z ^ (z >> 31n);
  }

  nextInt(bound: number): number {
    return Number(this.next() % BigInt(bound));
  }
}
