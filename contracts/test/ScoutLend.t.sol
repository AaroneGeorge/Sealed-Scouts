// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {FeedFixture} from "./utils/FeedFixture.sol";
import {TestToken} from "./utils/TestToken.sol";
import {PriceFeed} from "../src/PriceFeed.sol";
import {ScoutLend, IFinalPrice, IERC20Min} from "../src/ScoutLend.sol";
import {RoundAttestation, Leaf} from "../src/lib/RoundCodec.sol";

contract ScoutLendTest is FeedFixture {
    TestToken internal feth = new TestToken(18);
    TestToken internal fusd = new TestToken(6);
    ScoutLend internal lend;
    address internal alice = makeAddr("alice");
    address internal keeper = makeAddr("keeper");
    uint64 internal constant MAX_AGE = 600;

    function setUp() public override {
        super.setUp();
        lend = new ScoutLend(
            IFinalPrice(address(feed)), IERC20Min(address(feth)), IERC20Min(address(fusd)), 1, 3, 5000, 8000, MAX_AGE
        );
        fusd.mint(address(this), 100_000e6);
        fusd.approve(address(lend), type(uint256).max);
        lend.supply(100_000e6);

        feth.mint(alice, 1e18);
        vm.startPrank(alice);
        feth.approve(address(lend), type(uint256).max);
        fusd.approve(address(lend), type(uint256).max);
        lend.deposit(1e18);
        vm.stopPrank();
    }

    /// @notice Post a round where every scout reports fETH at `eth` and fUSD at 1.
    function _postEth(uint64 round, uint128 eth) internal {
        Leaf[] memory leaves = new Leaf[](4);
        for (uint256 i = 0; i < 4; i++) {
            (leaves[i],) = _leaf(feed, round, i, eth, 91_000e8, 1e8);
        }
        _post(feed, _att(round, leaves));
    }

    function test_borrowAtFinalFreshPrice() public {
        _postEth(1, 3000e8);
        vm.warp(block.timestamp + WINDOW);
        vm.prank(alice);
        lend.borrow(1000e6);
        assertEq(fusd.balanceOf(alice), 1000e6);
        (uint256 c, uint256 d) = lend.valueOf(alice);
        assertEq(c, 3000e8);
        assertEq(d, 1000e8);
    }

    function test_pendingPriceRefusesBorrow() public {
        _postEth(1, 3000e8);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PriceFeed.NoFinalPrice.selector, uint16(1)));
        lend.borrow(1000e6);
    }

    function test_stalePriceRefusesBorrow() public {
        _postEth(1, 3000e8);
        vm.warp(block.timestamp + MAX_AGE + 1);
        vm.prank(alice);
        vm.expectRevert();
        lend.borrow(1000e6);
    }

    function test_noPriceAtAllRefusesBorrow() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PriceFeed.NoFinalPrice.selector, uint16(1)));
        lend.borrow(1);
    }

    function test_borrowAboveLtvRefused() public {
        _postEth(1, 3000e8);
        vm.warp(block.timestamp + WINDOW);
        vm.prank(alice);
        vm.expectRevert(ScoutLend.Unhealthy.selector);
        lend.borrow(1500e6 + 1);
    }

    function test_withdrawKeepsPositionHealthy() public {
        _postEth(1, 3000e8);
        vm.warp(block.timestamp + WINDOW);
        vm.startPrank(alice);
        lend.borrow(1000e6);
        vm.expectRevert(ScoutLend.Unhealthy.selector);
        lend.withdraw(0.5e18);
        lend.withdraw(0.3e18);
        lend.repay(1000e6);
        lend.withdraw(0.7e18);
        vm.stopPrank();
        assertEq(feth.balanceOf(alice), 1e18);
    }

    function test_liquidationAfterPriceDrop() public {
        _postEth(1, 3000e8);
        vm.warp(block.timestamp + WINDOW);
        vm.prank(alice);
        lend.borrow(1400e6);

        vm.expectRevert(ScoutLend.Healthy.selector);
        lend.liquidate(alice);

        _postEth(2, 1700e8); // 1,700 × 80% = 1,360 < 1,400
        vm.expectRevert(ScoutLend.Healthy.selector); // still judged on the last final price while round 2 is pending
        lend.liquidate(alice);
        vm.warp(block.timestamp + WINDOW);

        fusd.mint(keeper, 1400e6);
        vm.startPrank(keeper);
        fusd.approve(address(lend), type(uint256).max);
        lend.liquidate(alice);
        vm.stopPrank();
        assertEq(feth.balanceOf(keeper), 1e18);
        (uint256 c, uint256 d) = lend.positions(alice);
        assertEq(c + d, 0);
    }

    /// @notice A wrong median that the court corrects never reaches the lender: it reads only settled prices.
    function test_courtCorrectedPriceIsWhatTheLenderSees() public {
        Leaf[] memory leaves = new Leaf[](4);
        for (uint256 i = 0; i < 4; i++) {
            (leaves[i],) = _leaf(feed, 1, i, 3000e8, 91_000e8, 1e8);
        }
        RoundAttestation memory att = _att(1, leaves);
        att.medians[0] = 30_000e8; // the operator inflates fETH tenfold to drain the pool
        _post(feed, att);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PriceFeed.NoFinalPrice.selector, uint16(1)));
        lend.borrow(10_000e6);

        feed.challengeMedian(1, leaves);
        vm.prank(alice);
        vm.expectRevert(ScoutLend.Unhealthy.selector);
        lend.borrow(10_000e6);
    }
}
