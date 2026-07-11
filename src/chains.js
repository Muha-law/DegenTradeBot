// Per-chain settings: WSS RPC env var, DEX factories to watch, and ids used
// by external APIs (GoPlus chain id, Etherscan V2 chainid, DexScreener chain slug).
//
// Each factory's `parse(args)` maps that event's raw arg list to
// [token0, token1, pairAddress] since different DEXs order/shape this
// differently (e.g. Aerodrome's PoolCreated has a `stable` bool between the
// tokens and the pool address).
const uniswapV2Factory = (address) => ({
  dexName: "uniswap-v2",
  address,
  abi: ["event PairCreated(address indexed token0, address indexed token1, address pair, uint256)"],
  event: "PairCreated",
  parse: (args) => [args[0], args[1], args[2]],
});

const pancakeV2Factory = (address) => ({
  dexName: "pancakeswap-v2",
  address,
  abi: ["event PairCreated(address indexed token0, address indexed token1, address pair, uint256)"],
  event: "PairCreated",
  parse: (args) => [args[0], args[1], args[2]],
});

const aerodromeFactory = (address) => ({
  dexName: "aerodrome",
  address,
  abi: [
    "event PoolCreated(address indexed token0, address indexed token1, bool indexed stable, address pool, uint256)",
  ],
  event: "PoolCreated",
  parse: (args) => [args[0], args[1], args[3]], // pool address is arg index 3 here, not 2
});

// Noxa's launch event name/full ABI isn't published anywhere — reverse
// engineered from live logs: topic0 below, with the new token address at
// topics[1]. Confirmed across many independent launches by cross-checking
// topics[1] against that same tx's ERC20 mint (Transfer from 0x0) event —
// it resolves to a real token with sensible name/symbol/supply every time.
// topics[3] is NOT a per-launch pool address — it's a fixed singleton
// contract shared by every launch (confirmed: identical value recurred
// across unrelated transactions). Using it as the dedup key meant the very
// first launch ever caught marked it "seen" and silently dropped every
// launch after that. The token address is the only field guaranteed unique
// per launch, so it doubles as its own dedup key here.
const noxaFactory = (address, wethAddress) => ({
  dexName: "noxa",
  address,
  topic0: "0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a",
  parse: (log) => {
    const token = `0x${log.topics[1].slice(26)}`;
    return [token, wethAddress, token];
  },
});

export const CHAINS = {
  ethereum: {
    label: "Ethereum",
    wssEnvVar: "ETHEREUM_WSS_RPC",
    nativeSymbol: "ETH",
    factories: [uniswapV2Factory("0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f")],
    wrappedNative: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
    // Uniswap V2 Router02 — verified on-chain (factory()/WETH() match the
    // addresses above) before being trusted for real-fund execution.
    routerAddress: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    goplusChainId: "1",
    etherscanChainId: 1,
    dexscreenerChainId: "ethereum",
  },
  base: {
    label: "Base",
    wssEnvVar: "BASE_WSS_RPC",
    nativeSymbol: "ETH",
    factories: [
      uniswapV2Factory("0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6"),
      aerodromeFactory("0x420dd381b31aef6683db6b902084cb0ffece40da"),
    ],
    wrappedNative: "0x4200000000000000000000000000000000000006", // WETH on Base
    // Verified on-chain against the uniswapV2Factory above.
    routerAddress: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    goplusChainId: "8453",
    etherscanChainId: 8453,
    dexscreenerChainId: "base",
  },
  bsc: {
    label: "BNB Chain",
    wssEnvVar: "BSC_WSS_RPC",
    nativeSymbol: "BNB",
    factories: [pancakeV2Factory("0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73")],
    wrappedNative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB
    // PancakeSwap V2 Router02 — verified on-chain.
    routerAddress: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    goplusChainId: "56",
    etherscanChainId: 56,
    dexscreenerChainId: "bsc",
  },
  arbitrum: {
    label: "Arbitrum",
    wssEnvVar: "ARBITRUM_WSS_RPC",
    nativeSymbol: "ETH",
    factories: [uniswapV2Factory("0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9")],
    wrappedNative: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH on Arbitrum
    // Verified on-chain against the factory above (same address as Base's
    // router — a CREATE2 deployment shared across chains).
    routerAddress: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    goplusChainId: "42161",
    etherscanChainId: 42161,
    dexscreenerChainId: "arbitrum",
  },
  robinhood: {
    label: "Robinhood Chain",
    wssEnvVar: "ROBINHOOD_WSS_RPC",
    // Robinhood Chain's public "feed" WSS is a proprietary Arbitrum Orbit
    // sequencer stream, not an eth_subscribe-compatible JSON-RPC endpoint —
    // confirmed by inspecting raw frames. Poll over HTTP instead.
    pollingOnly: true,
    httpRpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    nativeSymbol: "ETH",
    factories: [
      uniswapV2Factory("0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f"),
      noxaFactory("0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB", "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
    ],
    wrappedNative: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", // WETH on Robinhood Chain
    // Found by tracing a real swap transaction against a live Noxa-launched
    // pair, then confirmed via factory()/WETH() — the first candidate
    // address found this way was a different Noxa-specific contract, not
    // the router, so this was not just a memory-recalled address.
    routerAddress: "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba",
    // Uniswap V3 SwapRouter02 — some pairs on this chain (e.g. NPC) trade
    // exclusively through V3 concentrated-liquidity pools, invisible to the
    // V2 router above. Verified three independent ways: (1) Blockscout tags
    // this address "SwapRouter02" via the Open Labels Initiative, (2)
    // factory() returns 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA and
    // WETH9() returns the wrappedNative address below, both on-chain reads
    // against this exact address, (3) it's the dominant pool.swap() caller
    // on NPC's real, actively-traded V3 pool, and its real buy/sell calldata
    // decodes byte-for-byte as the standard SwapRouter02 exactInputSingle
    // ABI (selector 0x04e45aaf).
    v3RouterAddress: "0xCaf681a66D020601342297493863E78C959E5cb2",
    // QuoterV2 for the same V3 deployment as the router above. Verified three
    // independent ways: (1) Blockscout tags it "QuoterV2", (2) its factory()
    // and WETH9() reads match the router's exact factory/WETH addresses —
    // the only match out of 9 candidate Quoter/QuoterV2 contracts on this
    // chain, the rest belong to other DEX deployments sharing it, (3) a live
    // quoteExactInputSingle call against a real, high-liquidity pool (VLAD,
    // $3.2M) returned a correctly-shaped, plausible quote.
    v3QuoterAddress: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7",
    goplusChainId: "4663",
    etherscanChainId: 4663, // not on Etherscan V2 yet (Blockscout-based) — deployer history just degrades to neutral
    dexscreenerChainId: "robinhood",
  },
};
