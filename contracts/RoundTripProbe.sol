// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// Never deployed for real — only ever run via eth_call with a state override
// that plants this bytecode + a scratch native-currency balance at a throwaway
// address (see src/risk/roundTripProbe.js). Simulates "buy now, then
// immediately sell everything just bought" through the real router, so any
// tax/fee mechanism applies exactly as it would on a real trade — no need to
// guess a token's storage layout or find a real holder, unlike the
// revert-based check in sellability.js.
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IUniswapV2Router {
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable;

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

contract RoundTripProbe {
    // Each leg is wrapped in try/catch rather than left to revert the whole
    // call, so the caller can tell "the sell leg itself failed outright"
    // (as clear a honeypot signal as exists — real tokens were acquired via
    // a real buy, and could not be sold) apart from "something unrelated to
    // honeypot behavior went wrong" (inconclusive, not evidence either way).
    function probe(address router, address weth, address token, uint256 amountIn)
        external
        returns (bool buyOk, uint256 tokensReceived, bool sellOk, uint256 nativeReceived)
    {
        address[] memory buyPath = new address[](2);
        buyPath[0] = weth;
        buyPath[1] = token;

        try IUniswapV2Router(router).swapExactETHForTokensSupportingFeeOnTransferTokens{value: amountIn}(
            0,
            buyPath,
            address(this),
            block.timestamp
        ) {
            buyOk = true;
        } catch {
            return (false, 0, false, 0);
        }

        tokensReceived = IERC20(token).balanceOf(address(this));
        if (tokensReceived == 0) {
            return (true, 0, false, 0);
        }

        try IERC20(token).approve(router, tokensReceived) returns (bool ok) {
            if (!ok) return (true, tokensReceived, false, 0);
        } catch {
            return (true, tokensReceived, false, 0);
        }

        address[] memory sellPath = new address[](2);
        sellPath[0] = token;
        sellPath[1] = weth;

        uint256 balBefore = address(this).balance;
        try IUniswapV2Router(router).swapExactTokensForETHSupportingFeeOnTransferTokens(
            tokensReceived,
            0,
            sellPath,
            address(this),
            block.timestamp
        ) {
            sellOk = true;
            nativeReceived = address(this).balance - balBefore;
        } catch {
            return (true, tokensReceived, false, 0);
        }
    }

    receive() external payable {}
}
