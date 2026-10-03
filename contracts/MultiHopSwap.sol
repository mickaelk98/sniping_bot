// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Minimal Uniswap V3 SwapRouter02 surface used here.
/// @dev    SwapRouter02 (deployed on Base at 0x2626664c2603336E57B271c5C0b26F421741e481)
///         has NO `deadline` field in its params structs: the deadline is enforced
///         either via the `deadline()` multicall hook or by the caller. This contract
///         keeps its own deadline validation in `_validate`, so the field is simply
///         omitted when forwarding to the router.
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);

    function exactInput(ExactInputParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

/// @notice Minimal WETH interface for wrapping/unwrapping native ETH.
interface IWETH9 is IERC20 {
    function deposit() external payable;

    function withdraw(uint256 amount) external;
}

/// @title MultiHopSwap
/// @notice Non-custodial Uniswap V3 swap helper supporting single- and
///         multi-hop routes, plus native ETH in/out via WETH wrapping.
///         The contract never retains user funds or fees: everything is
///         pulled, swapped, and forwarded within a single transaction.
/// @dev    No owner, no admin, no pause, no rescue functions. There is
///         deliberately no privileged role that can move user assets.
///
///         Deployment (Base mainnet, chainId 8453):
///           router_ = 0x2626664c2603336E57B271c5C0b26F421741e481 (SwapRouter02)
///           weth_   = 0x4200000000000000000000000000000000000006 (WETH9 predeploy)
///
///         Base Sepolia (chainId 84532):
///           router_ = 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4
contract MultiHopSwap {
    using SafeERC20 for IERC20;

    /// @dev Set once at deploy time; can never change.
    ISwapRouter public immutable router;

    IWETH9 public immutable weth;

    /// @dev Sentinel used to mean "native ETH" in token arguments.
    address public constant NATIVE = address(0);

    error ZeroAmount();
    error DeadlineInPast();
    error InvalidPath();
    error WrongMsgValue();
    error EthTransferFailed();
    error NotWeth();

    event Swapped(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    constructor(address router_, address weth_) {
        if (router_ == address(0) || weth_ == address(0)) {
            revert InvalidPath();
        }

        router = ISwapRouter(router_);
        weth = IWETH9(weth_);
    }

    /// @notice Only WETH may send ETH here (during unwrap). This prevents
    ///         stray ETH from being trapped.
    receive() external payable {
        if (msg.sender != address(weth)) revert NotWeth();
    }

    // ---------------------------------------------------------------------
    // Single-hop
    // ---------------------------------------------------------------------

    /// @notice Swap an exact amount of one token for another (single pool).
    /// @param tokenIn      Input token, or NATIVE (address(0)) for ETH.
    /// @param tokenOut     Output token, or NATIVE for ETH.
    /// @param fee          Pool fee tier (e.g. 500, 3000, 10000).
    /// @param amountIn     Exact input amount (must equal msg.value if ETH).
    /// @param amountOutMin Minimum acceptable output (slippage guard).
    ///                      Computed dynamically by the off-chain bot from
    ///                      a configurable max slippage. NEVER hardcode it.
    /// @param deadline     Unix timestamp after which the swap reverts.
    ///                      Enforced by this contract (SwapRouter02 has no
    ///                      deadline field of its own).
    /// @return amountOut   Output amount delivered to msg.sender.
    function swapExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline
    ) external payable returns (uint256 amountOut) {
        _validate(amountIn, deadline);

        address realTokenIn = _receiveInput(tokenIn, amountIn);
        address realTokenOut = tokenOut == NATIVE ? address(weth) : tokenOut;

        bool ethOut = tokenOut == NATIVE;
        address recipient = ethOut ? address(this) : msg.sender;

        IERC20(realTokenIn).forceApprove(address(router), amountIn);

        amountOut = router.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: realTokenIn,
                tokenOut: realTokenOut,
                fee: fee,
                recipient: recipient,
                amountIn: amountIn,
                amountOutMinimum: amountOutMin,
                sqrtPriceLimitX96: 0
            })
        );

        IERC20(realTokenIn).forceApprove(address(router), 0);

        if (ethOut) _unwrapAndSend(amountOut);

        emit Swapped(msg.sender, tokenIn, tokenOut, amountIn, amountOut);
    }

    // ---------------------------------------------------------------------
    // Multi-hop
    // ---------------------------------------------------------------------

    /// @notice Swap along an arbitrary multi-hop route encoded as a V3 path.
    /// @dev    `path` must be tightly packed as
    ///         tokenA(20) | fee(3) | tokenB(20) | fee(3) | tokenC(20) | ...
    ///         Use `encodePath` to build it. The first token must be the
    ///         input token (or WETH if paying with ETH) and the last token
    ///         the output token (or WETH if receiving ETH).
    /// @param path         Encoded Uniswap V3 multi-hop path.
    /// @param ethIn        True if paying with native ETH.
    /// @param ethOut       True if receiving native ETH.
    /// @param amountIn     Exact input amount.
    /// @param amountOutMin Minimum acceptable output (slippage guard),
    ///                      computed dynamically off-chain. NEVER hardcode it.
    /// @param deadline     Expiry timestamp, enforced by this contract.
    /// @return amountOut   Output delivered to msg.sender.
    function swapExactInputMultihop(
        bytes calldata path,
        bool ethIn,
        bool ethOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline
    ) external payable returns (uint256 amountOut) {
        _validate(amountIn, deadline);

        if (path.length < 43) revert InvalidPath(); // 20 + 3 + 20 minimum

        address firstToken = _firstToken(path);
        address inputToken = ethIn ? NATIVE : firstToken;

        // Make sure the path actually starts with WETH when paying in ETH.
        if (ethIn && firstToken != address(weth)) revert InvalidPath();

        address realTokenIn = _receiveInput(inputToken, amountIn);
        address recipient = ethOut ? address(this) : msg.sender;

        IERC20(realTokenIn).forceApprove(address(router), amountIn);

        amountOut = router.exactInput(
            ISwapRouter.ExactInputParams({
                path: path,
                recipient: recipient,
                amountIn: amountIn,
                amountOutMinimum: amountOutMin
            })
        );

        IERC20(realTokenIn).forceApprove(address(router), 0);

        if (ethOut) _unwrapAndSend(amountOut);

        emit Swapped(
            msg.sender,
            inputToken,
            ethOut ? NATIVE : _lastToken(path),
            amountIn,
            amountOut
        );
    }

    // ---------------------------------------------------------------------
    // Path helper (pure)
    // ---------------------------------------------------------------------

    /// @notice Build a V3 path from ordered tokens and the fee between each
    ///         consecutive pair. `fees.length` must equal `tokens.length-1`.
    /// @dev    You can call this off-chain (it's pure) to construct `path`.
    function encodePath(address[] calldata tokens, uint24[] calldata fees)
        external
        pure
        returns (bytes memory path)
    {
        if (tokens.length < 2 || fees.length != tokens.length - 1) {
            revert InvalidPath();
        }

        path = abi.encodePacked(tokens[0]);

        for (uint256 i = 0; i < fees.length; ) {
            path = abi.encodePacked(path, fees[i], tokens[i + 1]);
            unchecked {
                ++i;
            }
        }
    }

    // ---------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------

    function _validate(uint256 amountIn, uint256 deadline) private view {
        if (amountIn == 0) revert ZeroAmount();
        if (deadline < block.timestamp) revert DeadlineInPast();
    }

    /// @dev Pulls input from the caller (or wraps incoming ETH) and returns
    ///      the ERC20 the router will actually receive (WETH for ETH).
    function _receiveInput(address tokenIn, uint256 amountIn)
        private
        returns (address realTokenIn)
    {
        if (tokenIn == NATIVE) {
            if (msg.value != amountIn) revert WrongMsgValue();
            weth.deposit{value: amountIn}();
            return address(weth);
        }

        if (msg.value != 0) revert WrongMsgValue();

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        return tokenIn;
    }

    /// @dev Unwraps WETH held by this contract and forwards ETH to caller.
    function _unwrapAndSend(uint256 amount) private {
        weth.withdraw(amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }

    /// @dev Reads the first 20-byte token address out of a packed path.
    function _firstToken(bytes calldata path)
        private
        pure
        returns (address token)
    {
        token = address(bytes20(path[0:20]));
    }

    /// @dev Reads the last 20-byte token address out of a packed path.
    function _lastToken(bytes calldata path)
        private
        pure
        returns (address token)
    {
        token = address(bytes20(path[path.length - 20:path.length]));
    }
}
