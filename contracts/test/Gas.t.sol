// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {console2} from "forge-std/console2.sol";
import {FeedFixture} from "./utils/FeedFixture.sol";
import {PriceFeed} from "../src/PriceFeed.sol";
import {RoundAttestation, Leaf} from "../src/lib/RoundCodec.sol";

/// @notice Gas for the calls that go on chain, in the steady state (round 2, feed heads already set).
///         The mock precompiles charge the real prices (25,000 + 8/byte and 2,500). Run with -vv to print.
/// @dev Forge runs each non-view top-level call as its own transaction here, so vm.lastCallGas() includes the
///      21,000 base and the calldata cost: these are whole-transaction numbers.
contract GasTest is FeedFixture {
    function test_gas_postRound() public {
        _postHonest(1, false);
        vm.warp(block.timestamp + WINDOW);
        (Leaf[] memory leaves,) = _leaves(feed, 2, false);
        RoundAttestation memory att = _att(2, leaves);
        bytes memory sig = _anchorSig(feed, att);
        bytes memory data = abi.encodeCall(PriceFeed.postRound, (att, _stateRoot(2), 5, sig));
        feed.postRound(att, _stateRoot(2), 5, sig);
        _report("postRound (vsh mode, 3 feeds)", vm.lastCallGas().gasTotalUsed, data);
    }

    function test_gas_postRoundTwoSig() public {
        PriceFeed two = _deploy(true);
        two.bondOperator{value: OP_BOND}();
        (Leaf[] memory first,) = _leaves(two, 1, false);
        _post(two, _att(1, first));
        (Leaf[] memory leaves,) = _leaves(two, 2, false);
        RoundAttestation memory att = _att(2, leaves);
        bytes memory sig = _anchorSig(two, att);
        bytes memory data = abi.encodeCall(PriceFeed.postRound, (att, _stateRoot(2), 5, sig));
        two.postRound(att, _stateRoot(2), 5, sig);
        _report("postRound (two-signature mode)", vm.lastCallGas().gasTotalUsed, data);
    }

    function test_gas_challengeMedian() public {
        (Leaf[] memory leaves,) = _leaves(feed, 1, false);
        RoundAttestation memory att = _att(1, leaves);
        att.medians[0] += 1e8;
        _post(feed, att);
        bytes memory data = abi.encodeCall(PriceFeed.challengeMedian, (1, leaves));
        feed.challengeMedian(1, leaves);
        _report("challengeMedian (4 leaves, 3 feeds)", vm.lastCallGas().gasTotalUsed, data);
    }

    function test_gas_slashOutlier() public {
        (, Leaf[] memory leaves, bytes[] memory sigs) = _postHonest(1, true);
        vm.warp(block.timestamp + WINDOW);
        bytes32[] memory proof = _proof(_hashes(leaves), 3);
        bytes memory data = abi.encodeCall(PriceFeed.slashOutlier, (1, leaves[3], proof, sigs[3]));
        feed.slashOutlier(1, leaves[3], proof, sigs[3]);
        _report("slashOutlier", vm.lastCallGas().gasTotalUsed, data);
    }

    function _report(string memory name, uint256 txGas, bytes memory data) internal pure {
        console2.log(name);
        console2.log("  calldata bytes", data.length);
        console2.log("  transaction gas", txGas);
    }
}
