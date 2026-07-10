import { ethers } from "ethers";
import { hasSeenPair, markPairSeen } from "../store/db.js";

const POLL_INTERVAL_MS = 5000;
const MAX_BLOCK_RANGE = 1000; // per-request cap; also how far a single cycle catches up if behind

function topic0For(factory) {
  if (factory.topic0) return factory.topic0;
  return new ethers.Interface(factory.abi).getEvent(factory.event).topicHash;
}

function decode(factory, log, iface) {
  if (factory.topic0) return factory.parse(log); // raw mode — parse works off the Log directly
  const parsed = iface.parseLog(log);
  return factory.parse(parsed.args);
}

// Same job as startPairWatcher, but for chains whose WS endpoint doesn't
// speak eth_subscribe (Robinhood Chain's public "feed" is a proprietary
// sequencer stream, not JSON-RPC). Polls eth_getLogs on an interval instead.
//
// Each factory tracks its own lastBlock/timer independently. A high-density
// event source (a launchpad firing every few seconds) and a quiet one
// sharing a chain must not be able to stall each other — a shared cursor
// meant one factory's transient failure froze progress for both, and the
// unprocessed range then grew every cycle until even more requests failed.
export function startPollingWatcher(chain, onNewToken) {
  let stopped = false;
  const provider = new ethers.JsonRpcProvider(chain.httpRpcUrl);

  function handleLog(factory, iface, log) {
    try {
      const [token0, token1, pairAddress] = decode(factory, log, iface);

      if (hasSeenPair(chain.key, pairAddress)) return;
      const wrapped = chain.wrappedNative.toLowerCase();
      const t0 = token0.toLowerCase();
      const t1 = token1.toLowerCase();
      if (t0 !== wrapped && t1 !== wrapped) return;

      const tokenAddress = t0 === wrapped ? token1 : token0;
      markPairSeen(chain.key, pairAddress, tokenAddress);
      onNewToken({ chain, dexName: factory.dexName, pairAddress, tokenAddress, timestamp: Date.now() });
    } catch (err) {
      console.error(`[${chain.key}/${factory.dexName}] error decoding log:`, err.message);
    }
  }

  const states = chain.factories.map((factory) => ({
    factory,
    topic0: topic0For(factory),
    iface: factory.topic0 ? null : new ethers.Interface(factory.abi),
    lastBlock: null,
    timer: null,
  }));

  async function pollOne(state) {
    if (stopped) return;
    try {
      const currentBlock = await provider.getBlockNumber();
      if (state.lastBlock === null) {
        state.lastBlock = currentBlock; // don't backfill on startup, just start watching forward
      } else if (currentBlock > state.lastBlock) {
        // Bounded catch-up: if we're behind by more than one chunk, only
        // advance one chunk this cycle instead of requesting the whole gap
        // in one (increasingly large, increasingly failure-prone) call.
        const to = Math.min(state.lastBlock + MAX_BLOCK_RANGE, currentBlock);
        const logs = await provider.getLogs({
          address: state.factory.address,
          topics: [state.topic0],
          fromBlock: state.lastBlock + 1,
          toBlock: to,
        });
        for (const log of logs) handleLog(state.factory, state.iface, log);
        state.lastBlock = to;
      }
    } catch (err) {
      console.error(`[${chain.key}/${state.factory.dexName}] poll failed:`, err.message);
    } finally {
      if (!stopped) state.timer = setTimeout(() => pollOne(state), POLL_INTERVAL_MS);
    }
  }

  for (const state of states) {
    console.log(`[${chain.key}] polling ${state.factory.dexName} (${state.factory.address}) every ${POLL_INTERVAL_MS}ms`);
    pollOne(state);
  }

  return function stop() {
    stopped = true;
    states.forEach((s) => {
      if (s.timer) clearTimeout(s.timer);
    });
  };
}
