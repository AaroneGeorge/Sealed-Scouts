// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {FeedFixture} from "./utils/FeedFixture.sol";
import {CodecHarness} from "./utils/CodecHarness.sol";
import {PriceFeed} from "../src/PriceFeed.sol";
import {RoundAttestation, Leaf} from "../src/lib/RoundCodec.sol";

contract FuzzTest is FeedFixture {
    CodecHarness internal codec = new CodecHarness();

    /// @notice The contract's median equals a plain sort-and-pick reference for any list.
    function testFuzz_medianMatchesReference(uint128[] memory values) public view {
        vm.assume(values.length > 0 && values.length <= 40);
        uint128[] memory copy = new uint128[](values.length);
        for (uint256 i = 0; i < values.length; i++) {
            copy[i] = values[i];
        }
        assertEq(codec.selectMedian(values), _median(copy));
    }

    /// @notice The court's per-feed median skips leaves of other rounds and feeds the leaf does not report.
    function testFuzz_medianOfCountsOnlyReportingLeaves(uint128 a, uint128 b, uint128 c, uint128 d) public view {
        Leaf[] memory leaves = new Leaf[](4);
        uint128[4] memory prices = [a, b, c, d];
        for (uint256 i = 0; i < 4; i++) {
            uint16[] memory ids = new uint16[](1);
            ids[0] = i == 3 ? 2 : 1; // the last leaf reports another feed
            uint128[] memory ps = new uint128[](1);
            ps[0] = prices[i];
            leaves[i] = Leaf(i == 2 ? 6 : 5, scouts[i], bytes16(0), ids, ps, bytes32(0)); // leaf 2: wrong round
        }
        (uint128 m, uint256 n) = codec.medianOf(leaves, 5, 1);
        uint128[] memory ref = new uint128[](2);
        (ref[0], ref[1]) = (a, b);
        assertEq(n, 2);
        assertEq(m, _median(ref));
    }

    /// @notice For any honest prices, the true round cannot be challenged, and any change to a median is slashed.
    function testFuzz_courtJudgesExactly(uint64[4] memory eth, uint128 delta) public {
        delta = uint128(bound(delta, 1, 1e12));
        Leaf[] memory leaves = new Leaf[](4);
        for (uint256 i = 0; i < 4; i++) {
            (leaves[i],) = _leaf(feed, 1, i, uint128(bound(eth[i], 1, 1e15)), 91_000e8, 1e8);
        }
        RoundAttestation memory att = _att(1, leaves);
        PriceFeed second = _deploy(false);
        second.bondOperator{value: OP_BOND}();

        _post(feed, att);
        vm.expectRevert(abi.encodeWithSelector(PriceFeed.HonestRound.selector, uint64(1)));
        feed.challengeMedian(1, leaves);

        att.medians[0] += delta;
        _post(second, att);
        second.challengeMedian(1, leaves);
        (uint128 bond,,) = second.bonds(operator);
        assertEq(bond, 0);
        (uint128 price,,) = second.points(1, 1);
        assertEq(price, att.medians[0] - delta);
    }

    /// @notice Outlier rule: slashable exactly when |p - m| * 10000 > 1000 * m.
    function testFuzz_outlierBoundary(uint128 median, uint256 offsetBps) public view {
        median = uint128(bound(median, 1e4, 1e30));
        offsetBps = bound(offsetBps, 0, 20_000);
        uint256 price = uint256(median) * (10_000 + offsetBps) / 10_000;
        uint256 diff = price - median;
        assertEq(codec.beyond(price, median, 1000), diff * 10_000 > 1000 * uint256(median));
        if (offsetBps <= 1000) assertFalse(codec.beyond(price, median, 1000));
    }
}
