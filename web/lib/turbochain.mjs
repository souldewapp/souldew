// The turbo-audio chain of player.html: the core's OpenAL context gain → mixer node (turboaudio.mjs) → volume gain → speakers.
//
// The core rebuilds its audio now and then (a lost WebGL context – a graphics process restart on Windows –, a changed DS
// screen layout, any core restart): Emscripten's OpenAL then makes a new AudioContext and drops the old one without
// closing it. The old chain kept running there, still wired to the speakers – a mixer caught in fast-forward played its
// loop on and on, and no speed, mode or volume change reached it any more (they go to the new chain). So a chain is
// retired as soon as a newer one takes over.
//
// Plain logic on Web Audio nodes: test/turboaudio.test.mjs drives it with stand-in nodes.

/**
 * What may be heard while fast-forwarding – decided by the page from its own state, never by the mixer or RetroArch, so
 * the chosen turbo audio mode always wins whatever happens to the audio objects underneath. Two gains per context:
 * `gate` – the core's sound that no mixer handles (a context the core just made, one it left behind, any connection
 *          straight to the speakers); before the first mixer is attached EmulatorJS still applies the volume itself.
 * `vol`  – the mixer's output (the music it plays, or the game's sound it lets through).
 * "mute" silences both while fast-forwarding; "music" lets only a working mixer through (a broken one could only pass the
 * game's sped-up sound on); "original" and "plain" are the core's own fast-forward sound. At 1× both are the volume.
 */
export function turboLevels({ ff = false, mode = 'music', volume = 1, attachedOnce = false, broken = false } = {}) {
  const v = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
  const pass = mode === 'original' || mode === 'plain';
  return {
    gate: ff && !pass ? 0 : attachedOnce ? v : 1,
    vol: !ff || pass || (mode === 'music' && !broken) ? v : 0,
  };
}

/** All chains player.html built, the current one last. */
export class MixerChains {
  constructor() {
    this.list = [];
    this.made = 0; // mixers ever built (a re-attach makes one more)
    this.closed = 0; // AudioContexts the core left behind that were closed here
  }

  /** A number for the next chain's mixer (its events carry it, so diagnostics can tell two mixers apart). */
  nextId() {
    return ++this.made;
  }

  /**
   * `chain` ({ id, al, node, vol, post }) is the one that plays from now on: every older chain is retired. `inUse(al)`
   * says whether the core still plays through that OpenAL context (then its sound goes back to the speakers through the
   * page's gate instead of being cut off).
   */
  adopt(chain, inUse = () => false) {
    // (a fresh mixer for the same context – the old one broke down: its context and OpenAL's gain stay, the new chain
    // wires that gain up right after)
    for (const old of this.list) if (old !== chain && !old.retired) this.retire(old, old.al === chain.al ? 'same' : inUse(old.al));
    this.list = [chain];
  }

  retire(chain, inUse) {
    const { al, node, vol } = chain;
    chain.retired = true;
    // the old mixer goes quiet and says nothing any more, whatever it was doing
    try {
      chain.post?.({ type: 'paused', paused: true });
    } catch {
      // gone already
    }
    if (node) {
      if (node.port) node.port.onmessage = null;
      if ('onaudioprocess' in node) node.onaudioprocess = null;
    }
    for (const n of [al?.gain, node, vol]) {
      try {
        n?.disconnect();
      } catch {
        // not connected
      }
    }
    const ac = al?.audioCtx;
    if (inUse === 'same') return;
    if (inUse) {
      al.gain.connect(ac.destination); // (player.html puts its gate in between)
      return;
    }
    if (ac && ac.state !== 'closed') {
      this.closed++;
      ac.close?.().catch?.(() => {});
    }
  }

  /** For diagnostics: mixers that can still be heard (1 once attached), built in all, contexts closed. */
  counts() {
    return { live: this.list.filter((c) => !c.retired).length, made: this.made, closedContexts: this.closed };
  }
}
