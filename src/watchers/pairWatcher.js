import { ethers } from "ethers";
import { getRpcUrl } from "../config.js";
import { hasSeenPair, markPairSeen } from "../store/db.js";

const RECONNECT_DELAY_MS = 5000;

// Subscribes to every configured DEX factory on a chain and calls
// onNewToken({ chain, dexName, pairAddress, tokenAddress, timestamp }) for
// the non-wrapped-native side of each new pair. Returns a stop() function.
export function startPairWatcher(chain, onNewToken) {
  let provider;
  let contracts = [];
  let stopped = false;
  let reconnectTimer = null;

  function scheduleReconnect(reason) {
    if (stopped || reconnectTimer) return; // 'close' and 'error' can both fire for one drop — only schedule once
    console.warn(`[${chain.key}] websocket disconnected (${reason}), reconnecting in ${RECONNECT_DELAY_MS}ms`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_DELAY_MS);
  }

  function connect() {
    if (stopped) return;

    // Clean up the previous socket/contracts before opening a new one so
    // dead listeners/timers don't pile up across reconnects.
    contracts.forEach((c) => c.removeAllListeners());
    provider?.destroy();

    try {
      connectOnce();
    } catch (err) {
      // A sync throw here (bad RPC URL, a factory event/ABI mismatch, etc.)
      // happens before the ws close/error handlers are attached below, so
      // without this catch it would only be caught by index.js's blanket
      // uncaughtException handler — which just logs and does nothing, leaving
      // this chain's watcher silently and permanently dead. Route it through
      // the same reconnect path as a normal disconnect instead.
      console.error(`[${chain.key}] failed to connect:`, err.message);
      scheduleReconnect(`connect error: ${err.message}`);
    }
  }

  function connectOnce() {
    const wssUrl = getRpcUrl(chain);
    provider = new ethers.WebSocketProvider(wssUrl);
    contracts = [];

    const handleParsed = (factory, token0, token1, pairAddress) => {
      if (hasSeenPair(chain.key, pairAddress)) return;

      const wrapped = chain.wrappedNative.toLowerCase();
      const t0 = token0.toLowerCase();
      const t1 = token1.toLowerCase();
      if (t0 !== wrapped && t1 !== wrapped) return; // only care about pairs against the native asset for now

      const tokenAddress = t0 === wrapped ? token1 : token0;
      markPairSeen(chain.key, pairAddress, tokenAddress);
      onNewToken({ chain, dexName: factory.dexName, pairAddress, tokenAddress, timestamp: Date.now() });
    };

    for (const factory of chain.factories) {
      if (factory.topic0) {
        // Raw-topic subscription: used when the real event name/signature
        // isn't publicly documented, only its topic0 hash (reverse-engineered
        // from live logs) and which topic slot holds the token address.
        // factory.parse receives the raw Log object here, not decoded args.
        provider.on({ address: factory.address, topics: [factory.topic0] }, (log) => {
          try {
            const [token0, token1, pairAddress] = factory.parse(log);
            handleParsed(factory, token0, token1, pairAddress);
          } catch (err) {
            console.error(`[${chain.key}/${factory.dexName}] error handling raw topic log:`, err);
          }
        });
        console.log(`[${chain.key}] watching ${factory.dexName} (${factory.address}) for topic ${factory.topic0}`);
        continue;
      }

      const contract = new ethers.Contract(factory.address, factory.abi, provider);
      contracts.push(contract);

      contract.on(factory.event, (...callbackArgs) => {
        try {
          callbackArgs.pop(); // trailing arg is ethers' event payload, not part of the log
          const [token0, token1, pairAddress] = factory.parse(callbackArgs);
          handleParsed(factory, token0, token1, pairAddress);
        } catch (err) {
          console.error(`[${chain.key}/${factory.dexName}] error handling ${factory.event}:`, err);
        }
      });

      console.log(`[${chain.key}] watching ${factory.dexName} (${factory.address}) for ${factory.event}`);
    }

    const ws = provider.websocket;
    ws.on("close", (code, reasonBuf) => {
      scheduleReconnect(`code ${code}${reasonBuf?.length ? `, reason: ${reasonBuf.toString()}` : ""}`);
    });
    ws.on("error", (err) => {
      console.error(`[${chain.key}] websocket error:`, err.message);
      scheduleReconnect(`error: ${err.message}`);
    });
  }

  connect();

  return function stop() {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    contracts.forEach((c) => c.removeAllListeners());
    provider?.destroy();
  };
}
