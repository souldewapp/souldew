// The turbo-audio chain of player.html: the core's OpenAL context gain → mixer node (turboaudio.mjs) → volume gain → speakers.
//
// The core rebuilds its audio now and then (a lost WebGL context – a graphics process restart on Windows –, a changed DS
// screen layout, any core restart): Emscripten's OpenAL then makes a new AudioContext and drops the old one without
// closing it. The old chain kept running there, still wired to the speakers – a mixer caught in fast-forward played its
// loop on and on, and no speed, mode or volume change reached it any more (they go to the new chain). So a chain is
// retired as soon as a newer one takes over.
//
// Plain logic on Web Audio nodes: test/turboaudio.test.mjs drives it with stand-in nodes.

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
    for (const old of this.list) if (old !== chain && !old.retired) this.retire(old, inUse(old.al));
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
