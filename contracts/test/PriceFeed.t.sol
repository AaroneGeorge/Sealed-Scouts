// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {FeedFixture} from "./utils/FeedFixture.sol";
import {PriceFeed} from "../src/PriceFeed.sol";
import {RoundAttestation, Leaf} from "../src/lib/RoundCodec.sol";

contract PriceFeedRoundsTest is FeedFixture {
    address internal tower = makeAddr("watchtower");

    // ------------------------------------------------------------ postRound

    function test_validAnchorIsAccepted() public {
        (RoundAttestation memory att,,) = _postHonest(1, false);
        (uint128 price, uint64 round, uint64 time, uint8 status) = feed.latest(1);
        assertEq(price, att.medians[0]);
        assertEq(round, 1);
        assertEq(time, att.closeTime);
        assertEq(status, uint8(PriceFeed.Status.Pending));
        assertTrue(feed.verifyReceipt(att, _stateRoot(1), 5, _anchorSig(feed, att)));
    }

    function test_oneChangedBitIsRefused() public {
        (Leaf[] memory leaves,) = _leaves(feed, 1, false);
        RoundAttestation memory att = _att(1, leaves);
        bytes memory sig = _anchorSig(feed, att);

        bytes memory badSig = bytes.concat(sig);
        badSig[100] ^= 0x01;
        vm.expectRevert(PriceFeed.BadSignature.selector);
        feed.postRound(att, _stateRoot(1), 5, badSig);

        // The same signature over a round whose fETH median moved by one unit.
        att.medians[0] ^= 1;
        vm.expectRevert(PriceFeed.BadSignature.selector);
        feed.postRound(att, _stateRoot(1), 5, sig);
        att.medians[0] ^= 1;

        vm.expectRevert(PriceFeed.BadSignature.selector);
        feed.postRound(att, _stateRoot(1) ^ bytes32(uint256(1)), 5, sig);
        vm.expectRevert(PriceFeed.BadSignature.selector);
        feed.postRound(att, _stateRoot(1), 4, sig);
        assertFalse(feed.verifyReceipt(att, _stateRoot(1), 5, badSig));

        feed.postRound(att, _stateRoot(1), 5, sig); // the untouched round still goes through
    }

    function test_signatureFromAnotherKeyIsRefused() public {
        (Leaf[] memory leaves,) = _leaves(feed, 1, false);
        RoundAttestation memory att = _att(1, leaves);
        bytes memory forged = verifier.sign(keccak256("attacker"), feed.anchorBytes(att, _stateRoot(1), 5));
        vm.expectRevert(PriceFeed.BadSignature.selector);
        feed.postRound(att, _stateRoot(1), 5, forged);
    }

    function test_failsClosedWithoutPrecompile() public {
        (Leaf[] memory leaves,) = _leaves(feed, 1, false);
        RoundAttestation memory att = _att(1, leaves);
        bytes memory sig = _anchorSig(feed, att);
        vm.etch(VERIFY, ""); // an inactive precompile returns empty data
        vm.expectRevert();
        feed.postRound(att, _stateRoot(1), 5, sig);
    }

    function test_unprovenOperatorKeyIsRefused() public {
        (Leaf[] memory leaves,) = _leaves(feed, 1, false);
        RoundAttestation memory att = _att(1, leaves);
        bytes memory sig = _anchorSig(feed, att);
        keyStatus.setKey(operator, verifier.addSeed(OP_SEED), 1, false);
        vm.expectRevert(abi.encodeWithSelector(PriceFeed.NoPqKey.selector, operator));
        feed.postRound(att, _stateRoot(1), 5, sig);
        assertFalse(feed.verifyReceipt(att, _stateRoot(1), 5, sig));
    }

    function test_replayAndOldRoundsAreRefused() public {
        (RoundAttestation memory att,,) = _postHonest(5, false);
        bytes memory sig = _anchorSig(feed, att);
        vm.expectRevert(PriceFeed.StaleRound.selector);
        feed.postRound(att, _stateRoot(5), 5, sig);

        (Leaf[] memory leaves,) = _leaves(feed, 4, false);
        RoundAttestation memory older = _att(4, leaves);
        bytes memory olderSig = _anchorSig(feed, older);
        vm.expectRevert(PriceFeed.StaleRound.selector);
        feed.postRound(older, _stateRoot(4), 5, olderSig);
    }

    function test_badAttestationsAreRefused() public {
        (Leaf[] memory leaves,) = _leaves(feed, 1, false);
        RoundAttestation memory att = _att(1, leaves);

        att.counts[1] = 2; // below quorum
        _expectBadAttestation(att);
        att.counts[1] = 4;

        att.feedIds[1] = 1; // not strictly ascending
        _expectBadAttestation(att);
        att.feedIds[1] = 2;

        att.medians[2] = 0;
        _expectBadAttestation(att);
        att.medians[2] = 1e8;

        att.closeTime = uint64(block.timestamp + 1); // from the future
        _expectBadAttestation(att);
    }

    function _expectBadAttestation(RoundAttestation memory att) internal {
        bytes memory sig = _anchorSig(feed, att);
        vm.expectRevert(PriceFeed.BadAttestation.selector);
        feed.postRound(att, _stateRoot(att.round), 5, sig);
    }

    function test_unbondedOperatorCannotPost() public {
        PriceFeed fresh = _deploy(false);
        (Leaf[] memory leaves,) = _leaves(fresh, 1, false);
        RoundAttestation memory att = _att(1, leaves);
        bytes memory sig = _anchorSig(fresh, att);
        vm.expectRevert(PriceFeed.OperatorNotBonded.selector);
        fresh.postRound(att, _stateRoot(1), 5, sig);
    }

    // ------------------------------------------------------------ two-signature mode

    function test_twoSigModeNeedsBothSignatures() public {
        PriceFeed two = _deploy(true);
        two.bondOperator{value: OP_BOND}();
        (Leaf[] memory leaves,) = _leaves(two, 1, false);
        RoundAttestation memory att = _att(1, leaves);
        bytes memory both = _anchorSig(two, att);
        assertEq(both.length, 2 * 4627);
        assertEq(two.anchorBytes(att, _stateRoot(1), 5).length, 148); // empty vsh

        // The anchor signature alone, or the vsh-mode signature, is not enough.
        bytes memory anchorOnly = verifier.sign(OP_SEED, two.anchorBytes(att, _stateRoot(1), 5));
        vm.expectRevert(PriceFeed.BadSignature.selector);
        two.postRound(att, _stateRoot(1), 5, anchorOnly);
        bytes memory wrongRound = bytes.concat(anchorOnly, verifier.sign(OP_SEED, two.roundSigMessage(2, bytes32(0))));
        vm.expectRevert(PriceFeed.BadSignature.selector);
        two.postRound(att, _stateRoot(1), 5, wrongRound);

        two.postRound(att, _stateRoot(1), 5, both);
        (, uint64 round,,) = two.latest(1);
        assertEq(round, 1);
    }

    // ------------------------------------------------------------ status and reads

    function test_pendingTurnsFinalAfterWindow() public {
        (RoundAttestation memory att,,) = _postHonest(1, false);
        vm.expectRevert(abi.encodeWithSelector(PriceFeed.NoFinalPrice.selector, uint16(1)));
        feed.readFinal(1, 1 hours);

        vm.warp(block.timestamp + WINDOW - 1);
        assertEq(uint8(feed.status(1)), uint8(PriceFeed.Status.Pending));
        vm.warp(block.timestamp + 1);
        assertEq(uint8(feed.status(1)), uint8(PriceFeed.Status.Final));
        (uint128 price, uint64 round) = feed.readFinal(1, 1 hours);
        assertEq(price, att.medians[0]);
        assertEq(round, 1);
    }

    function test_stalePriceReverts() public {
        (RoundAttestation memory att,,) = _postHonest(1, false);
        vm.warp(block.timestamp + WINDOW);
        uint64 age = uint64(block.timestamp) - att.closeTime;
        feed.readFinal(1, age);
        vm.expectRevert(abi.encodeWithSelector(PriceFeed.StalePrice.selector, uint16(1), uint64(1), att.closeTime));
        feed.readFinal(1, age - 1);
    }

    function test_readFinalUsesPreviousRoundWhileNewerIsPending() public {
        (RoundAttestation memory first,,) = _postHonest(1, false);
        vm.warp(block.timestamp + WINDOW);
        _postHonest(2, true);
        (, uint64 latestRound,, uint8 status) = feed.latest(1);
        assertEq(latestRound, 2);
        assertEq(status, uint8(PriceFeed.Status.Pending));
        (uint128 price, uint64 round) = feed.readFinal(1, 1 hours);
        assertEq(round, 1);
        assertEq(price, first.medians[0]);
    }

    // ------------------------------------------------------------ court

    function test_wrongMedianIsChallengedAndSlashed() public {
        (Leaf[] memory leaves,) = _leaves(feed, 1, false);
        RoundAttestation memory att = _att(1, leaves);
        uint128 right = att.medians[0];
        att.medians[0] = right * 105 / 100; // the operator lies by 5%
        _post(feed, att);

        uint256 towerBefore = tower.balance;
        vm.prank(tower);
        feed.challengeMedian(1, leaves);

        assertEq(tower.balance - towerBefore, OP_BOND / 2);
        assertEq(feed.totalBurned(), OP_BOND - OP_BOND / 2);
        (uint128 bond,,) = feed.bonds(operator);
        assertEq(bond, 0);
        (uint128 price,,, uint8 status) = feed.latest(1);
        assertEq(price, right);
        assertEq(status, uint8(PriceFeed.Status.Corrected));
        (uint128 finalPrice,) = feed.readFinal(1, 1 hours); // corrected rounds are final at once
        assertEq(finalPrice, right);

        vm.expectRevert(abi.encodeWithSelector(PriceFeed.NotPending.selector, uint64(1)));
        feed.challengeMedian(1, leaves);
    }

    function test_wrongCountIsAFault() public {
        (Leaf[] memory leaves,) = _leaves(feed, 1, false);
        RoundAttestation memory att = _att(1, leaves);
        att.counts[2] = 3;
        _post(feed, att);
        feed.challengeMedian(1, leaves);
        (, uint8 count,) = feed.points(1, 3);
        assertEq(count, 4);
    }

    function test_honestRoundCannotBeChallenged() public {
        (, Leaf[] memory leaves,) = _postHonest(1, true);
        vm.expectRevert(abi.encodeWithSelector(PriceFeed.HonestRound.selector, uint64(1)));
        feed.challengeMedian(1, leaves);
        (uint128 bond,,) = feed.bonds(operator);
        assertEq(bond, OP_BOND);
    }

    function test_challengeNeedsTheCommittedLeaves() public {
        (Leaf[] memory leaves,) = _leaves(feed, 1, false);
        RoundAttestation memory att = _att(1, leaves);
        att.medians[0] += 1e8;
        _post(feed, att);

        // A made-up report changes the root.
        Leaf[] memory forged = _copy(leaves);
        forged[0].prices[0] = 5000e8;
        vm.expectRevert(PriceFeed.RootMismatch.selector);
        feed.challengeMedian(1, forged);

        // Dropping a leaf changes the root.
        Leaf[] memory fewer = new Leaf[](3);
        for (uint256 i = 0; i < 3; i++) {
            fewer[i] = leaves[i];
        }
        vm.expectRevert(PriceFeed.RootMismatch.selector);
        feed.challengeMedian(1, fewer);

        // Out of order.
        (leaves[0], leaves[1]) = (leaves[1], leaves[0]);
        vm.expectRevert(PriceFeed.LeavesNotSorted.selector);
        feed.challengeMedian(1, leaves);
    }

    function test_challengeAfterWindowIsRefused() public {
        (Leaf[] memory leaves,) = _leaves(feed, 1, false);
        RoundAttestation memory att = _att(1, leaves);
        att.medians[0] += 1e8;
        _post(feed, att);
        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert(abi.encodeWithSelector(PriceFeed.NotPending.selector, uint64(1)));
        feed.challengeMedian(1, leaves);
    }

    function test_operatorCanPostAgainAfterRebond() public {
        (Leaf[] memory leaves,) = _leaves(feed, 1, false);
        RoundAttestation memory att = _att(1, leaves);
        att.medians[1] -= 1;
        _post(feed, att);
        feed.challengeMedian(1, leaves);

        (Leaf[] memory next,) = _leaves(feed, 2, false);
        RoundAttestation memory att2 = _att(2, next);
        bytes memory sig = _anchorSig(feed, att2);
        vm.expectRevert(PriceFeed.OperatorNotBonded.selector);
        feed.postRound(att2, _stateRoot(2), 5, sig);
        feed.bondOperator{value: MIN_BOND}();
        feed.postRound(att2, _stateRoot(2), 5, sig);
    }

    // ------------------------------------------------------------ outlier slashing

    function test_outlierIsSlashedWithItsOwnSignature() public {
        (, Leaf[] memory leaves, bytes[] memory sigs) = _postHonest(1, true);
        bytes32[] memory proof = _proof(_hashes(leaves), 3);

        vm.expectRevert(abi.encodeWithSelector(PriceFeed.NotFinal.selector, uint64(1)));
        feed.slashOutlier(1, leaves[3], proof, sigs[3]);

        vm.warp(block.timestamp + WINDOW);
        vm.prank(tower);
        feed.slashOutlier(1, leaves[3], proof, sigs[3]);
        (uint128 bond,,) = feed.bonds(scouts[3]);
        assertEq(bond, 0);
        assertEq(tower.balance, SCOUT_BOND / 2);
        assertTrue(feed.outlierSlashed(1, scouts[3]));

        vm.expectRevert(PriceFeed.AlreadySlashed.selector);
        feed.slashOutlier(1, leaves[3], proof, sigs[3]);
    }

    function test_inBandScoutIsNotSlashable() public {
        (, Leaf[] memory leaves, bytes[] memory sigs) = _postHonest(1, true);
        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert(PriceFeed.NotOutlier.selector);
        feed.slashOutlier(1, leaves[1], _proof(_hashes(leaves), 1), sigs[1]);
    }

    /// @notice The operator commits a leaf the scout never signed. Without the scout's own signature it cannot be
    ///         used against the scout, whatever bytes are offered as "the signature".
    function test_scoutCannotBeSlashedWithoutItsSignature() public {
        (Leaf[] memory leaves, bytes[] memory sigs) = _leaves(feed, 1, false);
        // Forged report for scouts[2]: far off, with the hash of a signature the operator made up.
        bytes memory fakeSig = verifier.sign(OP_SEED, feed.commitMessage(leaves[2]));
        leaves[2].prices[0] = 4000e8;
        leaves[2].commitSigHash = keccak256(fakeSig);
        RoundAttestation memory att = _att(1, leaves);
        _post(feed, att);
        vm.warp(block.timestamp + WINDOW);
        bytes32[] memory proof = _proof(_hashes(leaves), 2);

        vm.expectRevert(PriceFeed.BadSignature.selector);
        feed.slashOutlier(1, leaves[2], proof, fakeSig);
        // The scout's real signature is over different prices, so it does not match the forged leaf either.
        vm.expectRevert(PriceFeed.SigNotCommitted.selector);
        feed.slashOutlier(1, leaves[2], proof, sigs[2]);

        (uint128 bond,,) = feed.bonds(scouts[2]);
        assertEq(bond, SCOUT_BOND);
    }

    function test_slashNeedsLeafInRound() public {
        (, Leaf[] memory leaves, bytes[] memory sigs) = _postHonest(1, true);
        vm.warp(block.timestamp + WINDOW);
        bytes32[] memory wrongProof = _proof(_hashes(leaves), 0);
        vm.expectRevert(PriceFeed.NotInRound.selector);
        feed.slashOutlier(1, leaves[3], wrongProof, sigs[3]);
    }

    function _copy(Leaf[] memory leaves) internal pure returns (Leaf[] memory out) {
        out = new Leaf[](leaves.length);
        for (uint256 i = 0; i < leaves.length; i++) {
            Leaf memory l = leaves[i];
            uint128[] memory prices = new uint128[](l.prices.length);
            for (uint256 j = 0; j < prices.length; j++) {
                prices[j] = l.prices[j];
            }
            out[i] = Leaf(l.round, l.scout, l.salt, l.feedIds, prices, l.commitSigHash);
        }
    }
}
