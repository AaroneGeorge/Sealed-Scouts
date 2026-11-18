// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {FeedFixture} from "./utils/FeedFixture.sol";
import {PriceFeed} from "../src/PriceFeed.sol";
import {RoundAttestation, Leaf} from "../src/lib/RoundCodec.sol";

contract BondsTest is FeedFixture {
    address internal relayer = makeAddr("relayer");
    address internal payee = makeAddr("payee");

    function test_anyoneCanFundABond() public {
        vm.deal(relayer, 1 ether);
        vm.prank(relayer);
        feed.bondFor{value: 1 ether}(scouts[0]);
        (uint128 amount,,) = feed.bonds(scouts[0]);
        assertEq(amount, SCOUT_BOND + 1 ether);
        assertEq(address(feed).balance, feed.totalBonded());
    }

    function test_exitFlowWithPqSignatures() public {
        address scout = scouts[0];
        bytes memory exitSig = _exitSig(scout);
        vm.prank(relayer); // the relayer is not an authority, only a messenger
        feed.requestExit(scout, exitSig);
        (, uint64 exitAt, uint64 nonce) = feed.bonds(scout);
        assertEq(exitAt, block.timestamp + EXIT_DELAY);
        assertEq(nonce, 1);

        bytes memory withdrawSig = _withdrawSig(scout, payee);
        vm.expectRevert(PriceFeed.ExitNotReady.selector);
        feed.withdrawBond(scout, payee, withdrawSig);

        vm.warp(exitAt);
        // A signature for one payee cannot send the bond to another.
        vm.expectRevert(PriceFeed.BadSignature.selector);
        feed.withdrawBond(scout, relayer, withdrawSig);

        vm.prank(relayer);
        feed.withdrawBond(scout, payee, withdrawSig);
        assertEq(payee.balance, SCOUT_BOND);
        (uint128 amount, uint64 exitAfter, uint64 nonceAfter) = feed.bonds(scout);
        assertEq(amount, 0);
        assertEq(exitAfter, 0);
        assertEq(nonceAfter, 2);
        assertEq(address(feed).balance, feed.totalBonded() + feed.totalBurned());
    }

    function test_exitNeedsTheOwnersKey() public {
        address scout = scouts[0];
        // msg.sender == the scout's own EVM address still proves nothing: a stolen ECDSA key would give that.
        bytes memory fromOtherKey = verifier.sign(seedOf[scouts[1]], _qoreSign(feed.exitText(scout, 0)));
        vm.prank(scout);
        vm.expectRevert(PriceFeed.BadSignature.selector);
        feed.requestExit(scout, fromOtherKey);
    }

    function test_exitSignatureWorksOnce() public {
        address scout = scouts[0];
        bytes memory exitSig = _exitSig(scout);
        feed.requestExit(scout, exitSig);
        vm.warp(block.timestamp + EXIT_DELAY);
        feed.withdrawBond(scout, payee, _withdrawSig(scout, payee));

        feed.bondFor{value: 1 ether}(scout); // bonded again: the old exit signature has a spent nonce
        vm.expectRevert(PriceFeed.BadSignature.selector);
        feed.requestExit(scout, exitSig);
    }

    function test_exitWithoutKeyOrBond() public {
        address stranger = makeAddr("stranger");
        vm.expectRevert(PriceFeed.NothingBonded.selector);
        feed.requestExit(stranger, "");
        feed.bondFor{value: 1 ether}(stranger);
        vm.expectRevert(abi.encodeWithSelector(PriceFeed.NoPqKey.selector, stranger));
        feed.requestExit(stranger, new bytes(4627));
    }

    function test_exitingOperatorStopsPostingAndKeepsBondAtRiskUntilFinal() public {
        (Leaf[] memory leaves,) = _leaves(feed, 1, false);
        RoundAttestation memory att = _att(1, leaves);
        att.medians[0] += 1e8;
        _post(feed, att);
        feed.requestExit(operator, _exitSig(operator));

        (Leaf[] memory next,) = _leaves(feed, 2, false);
        RoundAttestation memory att2 = _att(2, next);
        bytes memory sig = _anchorSig(feed, att2);
        vm.expectRevert(PriceFeed.OperatorNotBonded.selector);
        feed.postRound(att2, _stateRoot(2), 5, sig);

        // The pending wrong round can still be judged; the exit delay outlasts the window.
        feed.challengeMedian(1, leaves);
        vm.warp(block.timestamp + EXIT_DELAY);
        feed.withdrawBond(operator, payee, _withdrawSig(operator, payee));
        assertEq(payee.balance, 0);
    }

    function test_badConfigIsRefused() public {
        vm.expectRevert(PriceFeed.BadConfig.selector);
        new PriceFeed(operator, CHAIN, ROLLUP, false, WINDOW, WINDOW, MIN_BOND); // exit delay below two windows
        vm.expectRevert(PriceFeed.BadConfig.selector);
        new PriceFeed(address(0), CHAIN, ROLLUP, false, WINDOW, EXIT_DELAY, MIN_BOND);
        vm.expectRevert();
        new PriceFeed(operator, CHAIN, "a-rollup-id-longer-than-31-bytes!", false, WINDOW, EXIT_DELAY, MIN_BOND);
    }

    function test_zeroBondIsRefused() public {
        vm.expectRevert(PriceFeed.ZeroValue.selector);
        feed.bondFor{value: 0}(scouts[0]);
    }
}
