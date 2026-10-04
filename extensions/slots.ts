/**
 * 🎰 Slot Machine extension - play with /slots command
 *
 * Spin the reels while the AI thinks! Credits persist across sessions.
 * SPACE to spin, +/- to change bet, P for paytable, R to refill, Q to quit.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, visibleWidth } from "@mariozechner/pi-tui";

// ─── Config ────────────────────────────────────────────────────────────────

const TICK_MS = 80;

// Tick indices at which each reel stops (counted from spin start)
const STOP_TICKS = [14, 21, 29] as const;

// Inner content width (between the │ borders)
const W = 46;

// Reel layout constants
const REEL_INDENT = 11;        // leading spaces before reel boxes
const REEL_BLOCK_W = 21;       // 3 reels × 5 chars + 2 gaps × 3 chars
const REEL_TRAILING = W - REEL_INDENT - REEL_BLOCK_W; // = 14

// ─── Symbols ───────────────────────────────────────────────────────────────

type Sym = "♦" | "★" | "7" | "♠" | "♥" | "♣" | "●" | "▲";

// Weighted reel strip  — ▲ (cherry) most common, ♦ (diamond) rarest
const STRIP: Sym[] = [
  "▲", "♣", "●", "▲", "♥", "▲", "♣", "♠",
  "▲", "●", "♥", "7",  "▲", "♣", "★", "♦",
];
const STRIP_LEN = STRIP.length; // 16

// ─── ANSI helpers ──────────────────────────────────────────────────────────

const dim    = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold   = (s: string) => `\x1b[1m${s}\x1b[22m`;
const invert = (s: string) => `\x1b[7m${s}\x1b[27m`;

function colorSym(s: Sym, bright = false): string {
  const codes: Record<Sym, [string, string]> = {
    "♦": ["\x1b[36m",    "\x1b[96;1m"],
    "★": ["\x1b[33m",    "\x1b[93;1m"],
    "7":  ["\x1b[31m",    "\x1b[91;1m"],
    "♠": ["\x1b[37m",    "\x1b[97;1m"],
    "♥": ["\x1b[31m",    "\x1b[91m"  ],
    "♣": ["\x1b[32m",    "\x1b[92m"  ],
    "●": ["\x1b[33m",    "\x1b[93m"  ],
    "▲": ["\x1b[35m",    "\x1b[95m"  ],
  };
  const [normal, brightCode] = codes[s];
  return `${bright ? brightCode : normal}${s}\x1b[0m`;
}

// ─── Paytable ──────────────────────────────────────────────────────────────

interface PayEntry {
  syms: [Sym, Sym, Sym];
  mult: number;
  label: string;
}

const PAYTABLE: PayEntry[] = [
  { syms: ["♦", "♦", "♦"], mult: 100, label: "JACKPOT!!" },
  { syms: ["★", "★", "★"], mult:  50, label: "BIG WIN!" },
  { syms: ["7",  "7",  "7" ], mult:  30, label: "LUCKY 7s!" },
  { syms: ["♠", "♠", "♠"], mult:  20, label: "SPADES!" },
  { syms: ["♥", "♥", "♥"], mult:  15, label: "HEARTS!" },
  { syms: ["♣", "♣", "♣"], mult:  10, label: "CLUBS!" },
  { syms: ["●", "●", "●"], mult:   5, label: "BELLS!" },
  { syms: ["▲", "▲", "▲"], mult:   3, label: "CHERRIES!" },
];

function evalResult(payline: [Sym, Sym, Sym], bet: number): { win: number; label: string } {
  for (const e of PAYTABLE) {
    if (e.syms[0] === payline[0] && e.syms[1] === payline[1] && e.syms[2] === payline[2]) {
      return { win: e.mult * bet, label: e.label };
    }
  }
  const [a, b, c] = payline;
  if (a === b || b === c || a === c) {
    return { win: bet, label: "Pair!" };
  }
  return { win: 0, label: "" };
}

// ─── State ─────────────────────────────────────────────────────────────────

type Phase = "idle" | "spinning" | "result";

/** Data that persists between sessions */
interface SavedState {
  credits: number;
  bet: number;
  highWin: number;
  totalSpins: number;
}

interface GameState extends SavedState {
  phase: Phase;
  lastWin: number;
  lastWinLabel: string;
  reelPos: [number, number, number];
  reelTarget: [number, number, number];
  tickCount: number;
  showPaytable: boolean;
  flashCount: number;  // for win flash animation
  errorMsg: string;    // brief error display
}

function initGame(saved?: Partial<SavedState>): GameState {
  return {
    credits:    saved?.credits    ?? 100,
    bet:        Math.min(Math.max(saved?.bet ?? 1, 1), 10),
    highWin:    saved?.highWin    ?? 0,
    totalSpins: saved?.totalSpins ?? 0,

    phase: "idle",
    lastWin: 0,
    lastWinLabel: "",
    reelPos:    [2, 7, 12],
    reelTarget: [2, 7, 12],
    tickCount: 0,
    showPaytable: false,
    flashCount: 0,
    errorMsg: "",
  };
}

// ─── Component ─────────────────────────────────────────────────────────────

const SAVE_KEY = "slot-machine";

class SlotComponent {
  private g: GameState;
  private interval: ReturnType<typeof setInterval> | null = null;
  private tui: { requestRender(): void };
  private onClose: () => void;
  private onSave: (s: SavedState) => void;

  // Render cache
  private ver = 0;
  private cachedVer = -1;
  private cachedW = 0;
  private cachedLines: string[] = [];

  constructor(
    tui: { requestRender(): void },
    onClose: () => void,
    onSave: (s: SavedState) => void,
    saved?: Partial<SavedState>,
  ) {
    this.tui = tui;
    this.onClose = onClose;
    this.onSave = onSave;
    this.g = initGame(saved);
    this.interval = setInterval(() => this.tick(), TICK_MS);
  }

  // ── Game loop ─────────────────────────────────────────────────────────────

  private tick(): void {
    const g = this.g;

    if (g.phase === "spinning") {
      g.tickCount++;

      // Advance each still-spinning reel by one position
      for (let i = 0; i < 3; i++) {
        if (g.tickCount < STOP_TICKS[i]) {
          g.reelPos[i] = (g.reelPos[i] + 1) % STRIP_LEN;
        } else if (g.tickCount === STOP_TICKS[i]) {
          // Snap to pre-determined result
          g.reelPos[i] = g.reelTarget[i];
        }
      }

      // All reels stopped → evaluate
      if (g.tickCount >= STOP_TICKS[2]) {
        const payline: [Sym, Sym, Sym] = [
          STRIP[g.reelPos[0]],
          STRIP[g.reelPos[1]],
          STRIP[g.reelPos[2]],
        ];
        const { win, label } = evalResult(payline, g.bet);
        g.credits += win;
        g.lastWin = win;
        g.lastWinLabel = label;
        if (win > g.highWin) g.highWin = win;
        g.phase = "result";
        g.flashCount = 0;
      }

      this.bump();

    } else if (g.phase === "result") {
      g.flashCount++;
      if (g.flashCount > 10) {
        g.phase = "idle";
      }
      this.bump();
    }
    // idle → no tick work needed
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    const g = this.g;

    // Always: Q / Escape → exit
    if (data === "q" || data === "Q" || matchesKey(data, "escape")) {
      this.dispose();
      this.onSave(this.snapshot());
      this.onClose();
      return;
    }

    // Always: P → toggle paytable
    if (data === "p" || data === "P") {
      g.showPaytable = !g.showPaytable;
      this.bump();
      return;
    }

    // Only in idle:
    if (g.phase === "idle") {
      if (data === " " || matchesKey(data, "enter")) {
        this.spin();
        return;
      }

      if (data === "+" || data === "=") {
        g.bet = Math.min(g.bet + 1, 10);
        this.bump();
        return;
      }

      if (data === "-" || data === "_") {
        g.bet = Math.max(g.bet - 1, 1);
        this.bump();
        return;
      }

      // R → refill credits (when broke)
      if ((data === "r" || data === "R") && g.credits === 0) {
        g.credits = 100;
        g.bet = 1;
        g.errorMsg = "";
        this.bump();
        return;
      }
    }
  }

  // ── Spin ──────────────────────────────────────────────────────────────────

  private spin(): void {
    const g = this.g;

    // Cap bet to available credits
    const bet = Math.min(g.bet, g.credits);
    if (bet <= 0) {
      g.errorMsg = "No credits! Press R to refill.";
      this.bump();
      return;
    }
    g.bet = bet;
    g.credits -= bet;
    g.totalSpins++;
    g.errorMsg = "";

    // Pre-determine which strip position each reel lands on
    for (let i = 0; i < 3; i++) {
      g.reelTarget[i] = Math.floor(Math.random() * STRIP_LEN);
    }

    g.phase = "spinning";
    g.tickCount = 0;
    g.lastWin = 0;
    g.lastWinLabel = "";
    this.bump();
  }

  // ── Render ────────────────────────────────────────────────────────────────

  invalidate(): void {
    this.cachedW = 0;
    this.cachedVer = -1;
  }

  render(width: number): string[] {
    if (this.cachedW === width && this.cachedVer === this.ver) {
      return this.cachedLines;
    }

    const g = this.g;
    const lines: string[] = [];
    const hbar = "─".repeat(W);

    // Helper: pad content to W chars, then wrap with dim box borders
    const bline = (content: string): string => {
      const cv = visibleWidth(content);
      return dim(" │") + content + " ".repeat(Math.max(0, W - cv)) + dim("│");
    };

    // Helper: center a string (raw display width provided) inside W
    const center = (s: string, displayW: number): string => {
      const total = Math.max(0, W - displayW);
      const left = Math.floor(total / 2);
      const right = total - left;
      return " ".repeat(left) + s + " ".repeat(right);
    };

    // ── Top border ──────────────────────────────────────────────────────────
    lines.push(this.pl(dim(` ╭${hbar}╮`), width));

    // ── Title ───────────────────────────────────────────────────────────────
    const titleRaw = "  SLOT  MACHINE  ";
    const titleStyled = `\x1b[93;1m★${titleRaw}★\x1b[0m`;
    lines.push(this.pl(bline(center(titleStyled, titleRaw.length + 2)), width));

    lines.push(this.pl(dim(` ├${hbar}┤`), width));

    // ── Credits / Bet / Win stats ────────────────────────────────────────────
    const credStr = `\x1b[93;1m${g.credits}\x1b[0m`;
    const betStr  = `\x1b[96;1m${g.bet}\x1b[0m`;
    let winStr: string;
    if (g.lastWin > 0) {
      winStr = `\x1b[92;1m+${g.lastWin}\x1b[0m`;
    } else if (g.phase === "idle" && g.totalSpins > 0 && g.lastWin === 0 && !g.lastWinLabel) {
      winStr = dim("0");
    } else {
      winStr = dim("–");
    }
    lines.push(this.pl(bline(` Credits: ${credStr}   Bet: ${betStr}   Won: ${winStr}`), width));

    lines.push(this.pl(dim(` ├${hbar}┤`), width));

    // ── Reels or Paytable ───────────────────────────────────────────────────
    if (g.showPaytable) {
      this.renderPaytable(lines, bline, width);
    } else {
      this.renderReels(lines, bline, width);
    }

    lines.push(this.pl(dim(` ├${hbar}┤`), width));

    // ── Status message ──────────────────────────────────────────────────────
    lines.push(this.pl(bline(this.statusLine(g)), width));

    lines.push(this.pl(dim(` ├${hbar}┤`), width));

    // ── Controls ────────────────────────────────────────────────────────────
    const ctrl = ` ${bold("SPACE")} spin  ${bold("+/-")} bet  ${bold("P")} paytable`
      + (g.credits === 0 ? `  ${bold("R")} refill` : "")
      + `  ${bold("Q")} quit`;
    lines.push(this.pl(bline(ctrl), width));

    // ── Bottom border ────────────────────────────────────────────────────────
    lines.push(this.pl(dim(` ╰${hbar}╯`), width));

    this.cachedLines = lines;
    this.cachedW = width;
    this.cachedVer = this.ver;
    return lines;
  }

  private renderReels(
    lines: string[],
    bline: (s: string) => string,
    width: number,
  ): void {
    const g = this.g;
    const isWinFlash = g.phase === "result" && g.lastWin > 0 && g.flashCount % 2 === 0;
    const indent = " ".repeat(REEL_INDENT);
    const trailing = " ".repeat(REEL_TRAILING);

    // Blank row
    lines.push(this.pl(bline(""), width));

    // Top box border
    lines.push(this.pl(
      bline(indent + dim("┌───┐   ┌───┐   ┌───┐") + trailing),
      width,
    ));

    // Symbol rows: -1 (above payline), 0 (payline), +1 (below payline)
    for (let row = -1; row <= 1; row++) {
      const isPayline = row === 0;

      let reelBlock = "";
      for (let r = 0; r < 3; r++) {
        const pos = ((g.reelPos[r] + row) % STRIP_LEN + STRIP_LEN) % STRIP_LEN;
        const sym = STRIP[pos];

        if (isPayline) {
          const rendered = isWinFlash
            ? invert(colorSym(sym, true))
            : colorSym(sym, true);
          reelBlock += `│ ${rendered} │`;
        } else {
          reelBlock += dim(`│ ${sym} │`);
        }
        if (r < 2) reelBlock += "   ";
      }
      // reelBlock visible width = 21 chars

      if (isPayline) {
        const openArrow  = `\x1b[91;1m▶\x1b[0m`;
        const closeArrow = `\x1b[91;1m◀\x1b[0m`;
        // 9 spaces + ▶ + space aligns the reel │ with the non-payline rows (indent=11)
        // space + ◀ mirrors it on the right; trailing shrinks by 2 to keep total = W
        const content = " ".repeat(9) + openArrow + " "
          + reelBlock
          + " " + closeArrow + " ".repeat(REEL_TRAILING - 2);
        lines.push(this.pl(bline(content), width));
      } else {
        lines.push(this.pl(bline(indent + reelBlock + trailing), width));
      }
    }

    // Bottom box border
    lines.push(this.pl(
      bline(indent + dim("└───┘   └───┘   └───┘") + trailing),
      width,
    ));

    // Blank row
    lines.push(this.pl(bline(""), width));
  }

  private renderPaytable(
    lines: string[],
    bline: (s: string) => string,
    width: number,
  ): void {
    lines.push(this.pl(bline(bold("  PAYTABLE")), width));
    lines.push(this.pl(bline(dim("  " + "─".repeat(W - 4))), width));
    for (const e of PAYTABLE) {
      const syms = e.syms.map(s => colorSym(s)).join("  ");
      const mult = `\x1b[93;1m${e.mult}x\x1b[0m`;
      lines.push(this.pl(bline(`  ${syms}   →  ${mult} bet   ${dim(e.label)}`), width));
    }
    lines.push(this.pl(bline(dim("  Any pair (2 matching)  →  1x bet back")), width));
    lines.push(this.pl(bline(""), width));
    lines.push(this.pl(bline(dim("  Reel strip (weighted – ▲ common, ♦ rare):")), width));
    const stripDisplay = STRIP.map(s => colorSym(s)).join(" ");
    lines.push(this.pl(bline("  " + stripDisplay), width));
    lines.push(this.pl(bline(""), width));
  }

  private statusLine(g: GameState): string {
    if (g.errorMsg) return ` \x1b[91;1m${g.errorMsg}\x1b[0m`;

    switch (g.phase) {
      case "spinning":
        return ` \x1b[93;1m⟳  Spinning...\x1b[0m`;
      case "result":
        if (g.lastWin > 0) {
          return ` \x1b[92;1m${g.lastWinLabel}  +${g.lastWin} credits!\x1b[0m`;
        }
        return ` ${dim("No win. Better luck next spin!")}`;
      default: // idle
        if (g.credits === 0) {
          return ` \x1b[91;1mOut of credits!  Press R to refill 100.\x1b[0m`;
        }
        if (g.totalSpins === 0) {
          return ` ${dim("Press SPACE to spin the reels!")}`;
        }
        return ` ${dim(`Total spins: ${g.totalSpins}   Best win: `)}${
          g.highWin > 0 ? `\x1b[93;1m${g.highWin}\x1b[0m` : dim("0")
        }`;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private pl(line: string, width: number): string {
    const vw = visibleWidth(line);
    return line + " ".repeat(Math.max(0, width - vw));
  }

  private bump(): void {
    this.ver++;
    this.invalidate();
    this.tui.requestRender();
  }

  private snapshot(): SavedState {
    const g = this.g;
    return { credits: g.credits, bet: g.bet, highWin: g.highWin, totalSpins: g.totalSpins };
  }

  dispose(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

// ─── Extension entry point ─────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerCommand("slots", {
    description: "Play the slot machine! Spin to win while the AI works.",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Slot machine requires interactive mode", "error");
        return;
      }

      // Restore last saved state from session entries
      let saved: Partial<SavedState> | undefined;
      const entries = ctx.sessionManager.getEntries();
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.type === "custom" && e.customType === SAVE_KEY) {
          saved = e.data as Partial<SavedState>;
          break;
        }
      }

      await ctx.ui.custom((tui, _theme, _kb, done) =>
        new SlotComponent(
          tui,
          () => done(undefined),
          (state) => pi.appendEntry(SAVE_KEY, state),
          saved,
        ),
      );
    },
  });
}
