import { parseAbi } from "viem";

/**
 * Adresses vérifiées - Base mainnet (chainId 8453).
 * Sources : developers.uniswap.org (deployments V3 Base) et docs.base.org.
 * Ne jamais copier les adresses d'Ethereum mainnet.
 *
 * Base Sepolia (84532), pour tests uniquement :
 *   factory 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24
 *   router  0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4
 *   quoter  0xC5290058841028F1614F3A6F0F5816cAd0df5E27
 *   WETH identique au mainnet.
 */
export const CHAIN_ID = 8453;

export const UNISWAP_V3_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" as const;
export const SWAP_ROUTER_02 = "0x2626664c2603336E57B271c5C0b26F421741e481" as const;
/**
 * QuoterV2 : casse EIP-55 corrigée. ATTENTION, la page deployments V3 de
 * developers.uniswap.org affiche une casse checksum invalide (b871 au lieu
 * de B871) que viem rejette. La valeur hexadécimale, elle, est exacte.
 */
export const QUOTER_V2 = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" as const;
export const WETH9 = "0x4200000000000000000000000000000000000006" as const;
export const USDC_NATIVE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

/** Tokens de cotation acceptés dans le filtre du listener. */
export const QUOTE_TOKENS: Record<string, "WETH" | "USDC"> = {
  [WETH9.toLowerCase()]: "WETH",
  [USDC_NATIVE.toLowerCase()]: "USDC",
};

/** Events + lectures de la factory V3. */
export const FACTORY_ABI = parseAbi([
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
]);

/** Surface QuoterV2 utilisée pour les quotages buy/sell (anti-honeypot, TP/SL). */
export const QUOTER_V2_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceLimitX96After, uint160 sqrtPriceX96After, uint32 initializedSecondsAgo)",
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160 sqrtPriceLimitX96After, uint160 sqrtPriceX96After, uint32 initializedSecondsAgo)",
]);

/** ERC20 minimal : soldes, supply, métadonnées, approbations. */
export const ERC20_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function owner() view returns (address)",
]);

/** Surface SwapRouter02 utilisée en mode routeur direct (sans contrat helper). */
export const ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
  "function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256 amountOut)",
]);

/** Surface du contrat helper MultiHopSwap (mode contrat déployé). */
export const HELPER_CONTRACT_ABI = parseAbi([
  "function swapExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint256 amountOutMin, uint256 deadline) payable returns (uint256 amountOut)",
  "function swapExactInputMultihop(bytes path, bool ethIn, bool ethOut, uint256 amountIn, uint256 amountOutMin, uint256 deadline) payable returns (uint256 amountOut)",
]);

/** WETH9 : wrapping/unwrapping pour le mode routeur direct. */
export const WETH_ABI = parseAbi([
  "function deposit() payable",
  "function withdraw(uint256 amount)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

/**
 * Encode un path Uniswap V3 : token(20) | fee(3) | token(20) | fee(3) | ...
 * `fees.length` doit valoir `tokens.length - 1`.
 */
export function encodeV3Path(tokens: readonly `0x${string}`[], fees: readonly number[]): `0x${string}` {
  if (tokens.length < 2 || fees.length !== tokens.length - 1) {
    throw new Error("encodeV3Path : fees.length doit valoir tokens.length - 1 (>= 2 tokens)");
  }
  let hex = tokens[0].toLowerCase().slice(2);
  for (let i = 0; i < fees.length; i++) {
    const feeHex = fees[i].toString(16).padStart(6, "0");
    hex += feeHex + tokens[i + 1].toLowerCase().slice(2);
  }
  return `0x${hex}` as `0x${string}`;
}
