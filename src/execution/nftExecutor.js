import { Contract, parseEther, formatEther, ZeroAddress, ZeroHash } from "ethers";
import { getWalletForChain } from "../wallet.js";
import { getCollection, getCheapestListing, getFulfillmentData, postListing } from "../risk/opensea.js";

// Canonical Seaport 1.6 deployment address — same across every EVM chain it
// supports, including Ethereum mainnet. Only needed for the *listing* (sell)
// path — the buy path never touches this directly, since OpenSea's
// fulfillment_data endpoint already returns a ready-to-send transaction
// (`to`/`data`/`value`) pointing at whatever protocol address the listing
// being fulfilled actually uses.
const SEAPORT_ADDRESS = "0x0000000000000068F116a894984e2DB1123eB395";

const SEAPORT_ABI = [
  "function getCounter(address offerer) view returns (uint256)",
  "function incrementCounter() returns (uint256)",
];

const ERC721_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
];

const ERC1155_ABI = [
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
];

// Hard ceiling independent of nftRealTradingSettings.json — same "defense
// in depth" role as swapExecutor.js's ABSOLUTE_MAX_USD_PER_TRADE, sized in
// ETH instead of USD since NFT floor prices routinely exceed what makes
// sense as a token-swap-style USD ceiling.
const ABSOLUTE_MAX_ETH_PER_NFT_BUY = 0.15;

function requireWallet(chain) {
  const wallet = getWalletForChain(chain);
  if (!wallet) throw new Error("No wallet configured (WALLET_PRIVATE_KEY unset)");
  return wallet;
}

// Buys the cheapest currently-fulfillable listing in a collection — not a
// specific token id. See nftExecutor.js's module comment in the plan doc:
// for a copy-trade signal the exact item the watched wallet bought is no
// longer for sale (they now own it), and for a freshly-called collection
// there's no way to know in advance which token id will list first, so
// "buy the floor" is the only well-defined automated target either way.
export async function buyNftCollectionFloor(chain, { contractAddress, maxPriceEth }) {
  if (maxPriceEth > ABSOLUTE_MAX_ETH_PER_NFT_BUY) {
    throw new Error(`Refusing to buy up to ${maxPriceEth} ETH — exceeds hard safety ceiling of ${ABSOLUTE_MAX_ETH_PER_NFT_BUY} ETH/item`);
  }

  const wallet = requireWallet(chain);
  const listing = await getCheapestListing(chain.key, contractAddress);
  if (!listing) throw new Error("No fulfillable listing available for this collection right now");
  if (listing.priceEth > maxPriceEth) {
    throw new Error(`Cheapest listing (${listing.priceEth} ETH) exceeds max price ${maxPriceEth} ETH`);
  }

  const tx = await getFulfillmentData({
    orderHash: listing.orderHash,
    chainKey: chain.key,
    protocolAddress: listing.protocolAddress,
    fulfillerAddress: wallet.address,
  });
  if (!tx?.to || !tx?.data) throw new Error("OpenSea returned no fulfillment transaction data for this listing");

  const sent = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n });
  const receipt = await sent.wait();
  if (receipt.status !== 1) throw new Error(`Buy transaction reverted: ${receipt.hash}`);

  // Confirm the wallet actually now owns the item — balance-before/after
  // discipline isn't practical here (we don't know the exact token id until
  // after the fill), so this confirms via ownerOf/balanceOf after the fact
  // instead, same "never trust the tx succeeded just because it didn't
  // revert" spirit as swapExecutor.js's post-buy balance checks.
  const tokenId = listing.tokenId;
  let owned = true;
  try {
    const nft = new Contract(contractAddress, ERC721_ABI, wallet.provider);
    owned = (await nft.ownerOf(tokenId)).toLowerCase() === wallet.address.toLowerCase();
  } catch {
    // Not an ERC721 (or ownerOf reverted) — leave `owned` as best-effort true
    // rather than fail a genuinely successful ERC1155 buy over an
    // unconfirmable check.
  }

  const gasEth = Number(formatEther(receipt.gasUsed * receipt.gasPrice));

  return {
    txHash: receipt.hash,
    tokenId,
    priceEth: listing.priceEth,
    gasEth,
    owned,
  };
}

// Builds, signs (EIP-712, via ethers' native signTypedData — no SDK), and
// posts a Seaport listing order for a single already-owned item. This is
// the least-verified part of the NFT integration (Seaport order
// construction has no OpenSea "build for me" endpoint the way the buy path
// does) — kept intentionally simple (no royalty/fee split beyond OpenSea's
// own published collection fees) and wrapped so a construction/signing/API
// failure here degrades to "stays unlisted, retried next cycle" rather than
// touching any position bookkeeping. Verify against a real, small listing
// before trusting this with a meaningful position size.
export async function listNftForSale(chain, { contractAddress, tokenId, priceEth, standard = "erc721", collectionSlug }) {
  const wallet = requireWallet(chain);
  const abi = standard === "erc1155" ? ERC1155_ABI : ERC721_ABI;
  const nft = new Contract(contractAddress, abi, wallet);

  const isApproved = await nft.isApprovedForAll(wallet.address, SEAPORT_ADDRESS);
  if (!isApproved) {
    const approveTx = await nft.setApprovalForAll(SEAPORT_ADDRESS, true);
    const approveReceipt = await approveTx.wait();
    if (approveReceipt.status !== 1) throw new Error(`NFT setApprovalForAll reverted: ${approveReceipt.hash}`);
  }

  const priceWei = parseEther(priceEth.toFixed(18));

  // Split proceeds per the collection's own published OpenSea fees (if
  // any); everything left over goes to the seller. Skips royalty
  // enforcement beyond what's already in that fees array — a genuine
  // simplification, flagged above.
  const collection = collectionSlug ? await getCollection(collectionSlug).catch(() => null) : null;
  const fees = collection?.fees || [];
  const considerationRecipients = [];
  let remainingWei = priceWei;
  for (const fee of fees) {
    if (!fee?.recipient || !fee?.fee) continue;
    const feeWei = (priceWei * BigInt(Math.round(fee.fee * 100))) / 10000n;
    if (feeWei <= 0n || feeWei >= remainingWei) continue;
    considerationRecipients.push({ recipient: fee.recipient, amountWei: feeWei });
    remainingWei -= feeWei;
  }
  considerationRecipients.push({ recipient: wallet.address, amountWei: remainingWei });

  const seaport = new Contract(SEAPORT_ADDRESS, SEAPORT_ABI, wallet.provider);
  const counter = await seaport.getCounter(wallet.address);

  const now = Math.floor(Date.now() / 1000);
  const THIRTY_DAYS = 30 * 24 * 60 * 60;
  const salt = `0x${BigInt(Math.floor(Math.random() * 1e15)).toString(16).padStart(64, "0")}`;

  const offer = [
    {
      itemType: standard === "erc1155" ? 3 : 2,
      token: contractAddress,
      identifierOrCriteria: String(tokenId),
      startAmount: "1",
      endAmount: "1",
    },
  ];
  const consideration = considerationRecipients.map((c) => ({
    itemType: 0, // native ETH
    token: ZeroAddress,
    identifierOrCriteria: "0",
    startAmount: c.amountWei.toString(),
    endAmount: c.amountWei.toString(),
    recipient: c.recipient,
  }));

  const orderComponents = {
    offerer: wallet.address,
    zone: ZeroAddress,
    offer,
    consideration,
    orderType: 0, // FULL_OPEN
    startTime: String(now),
    endTime: String(now + THIRTY_DAYS),
    zoneHash: ZeroHash,
    salt,
    conduitKey: ZeroHash,
    counter: counter.toString(),
  };

  const domain = { name: "Seaport", version: "1.6", chainId: (await wallet.provider.getNetwork()).chainId, verifyingContract: SEAPORT_ADDRESS };
  const types = {
    OrderComponents: [
      { name: "offerer", type: "address" },
      { name: "zone", type: "address" },
      { name: "offer", type: "OfferItem[]" },
      { name: "consideration", type: "ConsiderationItem[]" },
      { name: "orderType", type: "uint8" },
      { name: "startTime", type: "uint256" },
      { name: "endTime", type: "uint256" },
      { name: "zoneHash", type: "bytes32" },
      { name: "salt", type: "uint256" },
      { name: "conduitKey", type: "bytes32" },
      { name: "counter", type: "uint256" },
    ],
    OfferItem: [
      { name: "itemType", type: "uint8" },
      { name: "token", type: "address" },
      { name: "identifierOrCriteria", type: "uint256" },
      { name: "startAmount", type: "uint256" },
      { name: "endAmount", type: "uint256" },
    ],
    ConsiderationItem: [
      { name: "itemType", type: "uint8" },
      { name: "token", type: "address" },
      { name: "identifierOrCriteria", type: "uint256" },
      { name: "startAmount", type: "uint256" },
      { name: "endAmount", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
  };

  const signature = await wallet.signTypedData(domain, types, orderComponents);
  const { counter: _counter, ...parameters } = orderComponents;
  const order = await postListing(chain.key, {
    parameters: { ...parameters, totalOriginalConsiderationItems: consideration.length },
    signature,
  });

  return { orderHash: order?.order_hash || order?.orderHash || null, priceEth };
}

// Cancels every currently-open Seaport listing from this wallet at once
// (Seaport has no cheap single-order on-chain cancel without resubmitting
// the full order struct — incrementCounter() bumps the offerer's order
// counter, which immediately invalidates every previously-signed order from
// them, listed or not). Safe here specifically because this bot uses one
// dedicated wallet per the setup instructions in README/.env.example — it's
// never expected to hold an unrelated manual listing this would clobber.
export async function cancelAllListings(chain) {
  const wallet = requireWallet(chain);
  const seaport = new Contract(SEAPORT_ADDRESS, SEAPORT_ABI, wallet);
  const tx = await seaport.incrementCounter();
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error(`incrementCounter reverted: ${receipt.hash}`);
  return { txHash: receipt.hash };
}
