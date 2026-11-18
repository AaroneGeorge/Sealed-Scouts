// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {FeedFixture} from "./utils/FeedFixture.sol";
import {PriceFeed} from "../src/PriceFeed.sol";
import {RoundAttestation, Leaf} from "../src/lib/RoundCodec.sol";

/// @notice Drives the feed with random rounds (some with a lying operator, some with an outlier scout), challenges,
///         outlier slashes, bonds, exits and time jumps. Ghost variables record what should be possible.
contract FeedHandler is FeedFixture {
    uint64 public lastRound;
    mapping(uint64 => bool) public lied;
    mapping(uint64 => bool) public hasOutlier;
    uint64[] public postedRounds;
    uint256 public lies;
    uint256 public challenges; // successful ones, so a run can show the court was exercised
    uint256 public slashes;
    uint256 public withdrawals;

    mapping(address => uint256) public deposited;
    mapping(address => uint256) public withdrawn;
    mapping(address => uint256) public framedLoss; // lost through an unchallenged lying round
    /// @notice Set if a slash went through without the proof it needs. Must stay false.
    bool public unjustSlash;

    // Final prices as first seen, per round and feed.
    uint64[] public snappedRounds;
    mapping(uint64 => mapping(uint16 => uint128)) public snapped;
    mapping(uint64 => bool) public isSnapped;

    address internal payee = address(0xBEEF);

    constructor() payable {
        setUp();
        deposited[operator] = OP_BOND;
        for (uint256 i = 0; i < scouts.length; i++) {
            deposited[scouts[i]] = SCOUT_BOND;
        }
    }

    function feedAddress() external view returns (address) {
        return address(feed);
    }

    function scoutAt(uint256 i) external view returns (address) {
        return scouts[i];
    }

    function postedCount() external view returns (uint256) {
        return postedRounds.length;
    }

    function snappedCount() external view returns (uint256) {
        return snappedRounds.length;
    }

    // ------------------------------------------------------------ actions

    function post(bool lie, bool outlier, uint64 skew) external {
        uint64 round = lastRound + 1;
        (Leaf[] memory leaves,) = _leaves(feed, round, outlier);
        RoundAttestation memory att = _att(round, leaves);
        if (lie) att.medians[uint256(skew) % 3] += 1 + (skew % 1e8);
        try feed.postRound(att, _stateRoot(round), 5, _anchorSig(feed, att)) {
            lastRound = round;
            lied[round] = lie;
            hasOutlier[round] = outlier;
            postedRounds.push(round);
            if (lie) lies++;
        } catch {}
        _snapshot();
    }

    function challenge(uint256 pick) external {
        if (postedRounds.length == 0) return;
        // Aim at the newest rounds: only those can still be pending.
        uint64 round = postedRounds[postedRounds.length - 1 - pick % _min(postedRounds.length, 2)];
        (Leaf[] memory leaves,) = _leaves(feed, round, hasOutlier[round]);
        try feed.challengeMedian(round, leaves) {
            challenges++;
            if (!lied[round]) unjustSlash = true;
        } catch {}
        _snapshot();
    }

    function slash(uint256 pick, uint256 scoutIdx) external {
        if (postedRounds.length == 0) return;
        uint64 round = postedRounds[pick % postedRounds.length];
        uint256 idx = scoutIdx % 2 == 0 ? 3 : scoutIdx % 4; // aim at the scout that may be an outlier half the time
        (Leaf[] memory leaves, bytes[] memory sigs) = _leaves(feed, round, hasOutlier[round]);
        (uint128 before,,) = feed.bonds(leaves[idx].scout);
        try feed.slashOutlier(round, leaves[idx], _proof(_hashes(leaves), idx), sigs[idx]) {
            slashes++;
            // An honest scout can lose its bond only to a lie nobody challenged in time (trust assumption: one
            // honest watchtower online in the window). In a truthful round it never can.
            if (idx != 3 || !hasOutlier[round]) {
                if (!lied[round]) unjustSlash = true;
                framedLoss[leaves[idx].scout] += before;
            }
        } catch {}
        _snapshot();
    }

    function bond(uint256 who, uint96 amount) external {
        amount = uint96(bound(amount, 1, 5 ether));
        address account = who % 6 == 5 ? operator : scouts[who % 5];
        feed.bondFor{value: amount}(account);
        deposited[account] += amount;
    }

    function exit(uint256 who) external {
        address scout = scouts[who % 5];
        try feed.requestExit(scout, _exitSig(scout)) {} catch {}
    }

    function withdraw(uint256 who) external {
        address scout = scouts[who % 5];
        (uint128 amount,,) = feed.bonds(scout);
        try feed.withdrawBond(scout, payee, _withdrawSig(scout, payee)) {
            withdrawn[scout] += amount;
            withdrawals++;
        } catch {}
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 400));
        _snapshot();
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function _snapshot() internal {
        for (uint256 i = 0; i < postedRounds.length; i++) {
            uint64 r = postedRounds[i];
            if (isSnapped[r] || feed.status(r) != PriceFeed.Status.Final) continue;
            isSnapped[r] = true;
            snappedRounds.push(r);
            for (uint16 f = 1; f <= 3; f++) {
                (snapped[r][f],,) = feed.points(r, f);
            }
        }
    }
}

contract InvariantsTest is Test {
    FeedHandler internal handler;
    PriceFeed internal feed;

    function setUp() public {
        handler = new FeedHandler{value: 100 ether}();
        vm.deal(address(handler), 1_000_000 ether);
        feed = PriceFeed(handler.feedAddress());
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = FeedHandler.post.selector;
        selectors[1] = FeedHandler.challenge.selector;
        selectors[2] = FeedHandler.slash.selector;
        selectors[3] = FeedHandler.bond.selector;
        selectors[4] = FeedHandler.exit.selector;
        selectors[5] = FeedHandler.withdraw.selector;
        selectors[6] = FeedHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice Every wei the feed holds is either a live bond or burned; nothing appears or leaks.
    function invariant_bondAccountingIsConserved() public view {
        assertEq(address(feed).balance, feed.totalBonded() + feed.totalBurned());
        uint256 sum;
        (uint128 op,,) = feed.bonds(feed.operator());
        sum += op;
        for (uint256 i = 0; i < 5; i++) {
            (uint128 b,,) = feed.bonds(handler.scoutAt(i));
            sum += b;
        }
        assertEq(sum, feed.totalBonded());
    }

    /// @notice Once a round is Final its prices never change (the court acts only while a round is pending).
    function invariant_finalPricesAreImmutable() public view {
        for (uint256 i = 0; i < handler.snappedCount(); i++) {
            uint64 r = handler.snappedRounds(i);
            assertEq(uint8(feed.status(r)), uint8(PriceFeed.Status.Final));
            for (uint16 f = 1; f <= 3; f++) {
                (uint128 price,,) = feed.points(r, f);
                assertEq(price, handler.snapped(r, f));
            }
        }
    }

    /// @notice No bond is lost without proof: an honest scout loses nothing in a truthful round (only an unchallenged
    ///         lie, i.e. no watchtower online, can cost it), and the operator loses its bond only if it posted a lie.
    function invariant_noSlashWithoutProof() public view {
        assertFalse(handler.unjustSlash());
        for (uint256 i = 0; i < 3; i++) {
            address s = handler.scoutAt(i);
            (uint128 b,,) = feed.bonds(s);
            assertEq(b, handler.deposited(s) - handler.withdrawn(s) - handler.framedLoss(s));
        }
        if (handler.lies() == 0) {
            (uint128 op,,) = feed.bonds(feed.operator());
            assertEq(op, handler.deposited(feed.operator()));
        }
    }
}
