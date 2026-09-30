// Which game the assistant is running against (PBA_GAME): Sword/Shield in Eden (default) or Black 2/White 2 in melonDS.
// Everything game-specific in the engine (calc generation, EXP rules, Dynamax, item values) keys off this.
export const GAME = process.env.PBA_GAME === "b2"
  ? { id: "b2", name: "Black 2", gen: 5 as const, dynamax: false, expShareAll: false }
  : { id: "swsh", name: "Sword", gen: 8 as const, dynamax: true, expShareAll: true };
