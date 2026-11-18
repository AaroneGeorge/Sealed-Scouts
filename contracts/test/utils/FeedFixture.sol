// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PriceFeed} from "../../src/PriceFeed.sol";
import {RoundAttestation, Leaf} from "../../src/lib/RoundCodec.sol";
import {MockPqc} from "./MockPqc.sol";

/// @notice Shared setup: mock precompiles, an operator and five scouts with mock ML-DSA keys, a bonded feed, and
///         helpers that build honest rounds the way packages/core does (re-implemented here, not taken from src).
abstract contract FeedFixture is Test {
    address internal constant VERIFY = address(uint160(0x0a01));
    address internal constant KEYS = address(uint160(0x0a02));
    MockPqc internal verifier = MockPqc(VERIFY);
    MockPqc internal keyStatus = MockPqc(KEYS);

    uint64 internal constant WINDOW = 120;
    uint64 internal constant EXIT_DELAY = 300;
    uint128 internal constant MIN_BOND = 1 ether;
    uint128 internal constant OP_BOND = 10 ether;
    uint128 internal constant SCOUT_BOND = 2 ether;
    string internal constant CHAIN = "qorechain-diana";
    string internal constant ROLLUP = "sealed-scouts-1";

    bytes32 internal constant OP_SEED = keccak256("operator seed");
    address internal operator = makeAddr("operator");
    address[] internal scouts;
    mapping(address => bytes32) internal seedOf;

    PriceFeed internal feed;

    function setUp() public virtual {
        MockPqc impl = new MockPqc();
        vm.etch(VERIFY, address(impl).code);
        vm.etch(KEYS, address(impl).code);
        vm.warp(1_800_000_000);

        _register(operator, OP_SEED);
        for (uint256 i = 0; i < 5; i++) {
            scouts.push(makeAddr(string(abi.encodePacked("scout", vm.toString(i)))));
        }
        _sortAddresses(scouts);
        for (uint256 i = 0; i < scouts.length; i++) {
            _register(scouts[i], keccak256(abi.encode("scout seed", i)));
        }

        feed = _deploy(false);
        feed.bondOperator{value: OP_BOND}();
        for (uint256 i = 0; i < scouts.length; i++) {
            feed.bondFor{value: SCOUT_BOND}(scouts[i]);
        }
    }

    /// @dev Tests act as challengers too, and challengers are paid in the native coin.
    receive() external payable {}

    function _deploy(bool twoSig) internal returns (PriceFeed) {
        return new PriceFeed(operator, CHAIN, ROLLUP, twoSig, WINDOW, EXIT_DELAY, MIN_BOND);
    }

    function _register(address who, bytes32 seed) internal {
        seedOf[who] = seed;
        bytes memory pubkey = verifier.addSeed(seed);
        keyStatus.setKey(who, pubkey, 1, true);
    }

    // ------------------------------------------------------------ leaves and rounds

    function _feeds() internal pure returns (uint16[] memory ids) {
        ids = new uint16[](3);
        (ids[0], ids[1], ids[2]) = (1, 2, 3);
    }

    /// @notice A leaf for scouts[idx] with a valid mock COMMIT signature over feed.commitMessage(leaf).
    function _leaf(PriceFeed f, uint64 round, uint256 idx, uint128 eth, uint128 btc, uint128 usd)
        internal
        view
        returns (Leaf memory leaf, bytes memory sig)
    {
        uint128[] memory prices = new uint128[](3);
        (prices[0], prices[1], prices[2]) = (eth, btc, usd);
        leaf = Leaf(round, scouts[idx], bytes16(keccak256(abi.encode(round, idx))), _feeds(), prices, bytes32(0));
        sig = verifier.sign(seedOf[scouts[idx]], f.commitMessage(leaf));
        leaf.commitSigHash = keccak256(sig);
    }

    /// @notice Four honest reports close together; scouts[3] is optionally far off on fETH.
    function _leaves(PriceFeed f, uint64 round, bool withOutlier)
        internal
        view
        returns (Leaf[] memory leaves, bytes[] memory sigs)
    {
        leaves = new Leaf[](4);
        sigs = new bytes[](4);
        (leaves[0], sigs[0]) = _leaf(f, round, 0, 3000e8, 91_000e8, 0.9999e8);
        (leaves[1], sigs[1]) = _leaf(f, round, 1, 3001e8, 91_050e8, 1.0001e8);
        (leaves[2], sigs[2]) = _leaf(f, round, 2, 2999e8, 90_980e8, 1e8);
        (leaves[3], sigs[3]) = _leaf(f, round, 3, withOutlier ? 3450e8 : 3002e8, 91_010e8, 0.9998e8);
    }

    /// @notice The honest attestation for these leaves (median rule and tree from docs/SPEC.md).
    function _att(uint64 round, Leaf[] memory leaves) internal view returns (RoundAttestation memory att) {
        uint16[] memory ids = _feeds();
        uint128[] memory medians = new uint128[](ids.length);
        uint8[] memory counts = new uint8[](ids.length);
        for (uint256 k = 0; k < ids.length; k++) {
            uint128[] memory xs = new uint128[](leaves.length);
            for (uint256 i = 0; i < leaves.length; i++) {
                xs[i] = leaves[i].prices[k];
            }
            medians[k] = _median(xs);
            counts[k] = uint8(leaves.length);
        }
        att = RoundAttestation({
            round: round,
            batchIndex: round + 100,
            inboxStart: round * 10,
            inboxEnd: round * 10 + 9,
            closeHeight: 1_000_000 + round * 300,
            closeTime: uint64(block.timestamp) - 10,
            feedIds: ids,
            medians: medians,
            counts: counts,
            reportsRoot: _root(_hashes(leaves)),
            reportCount: uint16(leaves.length)
        });
    }

    function _stateRoot(uint64 round) internal pure returns (bytes32) {
        return keccak256(abi.encode("state", round));
    }

    function _anchorSig(PriceFeed f, RoundAttestation memory att) internal view returns (bytes memory) {
        bytes memory anchorSig = verifier.sign(OP_SEED, f.anchorBytes(att, _stateRoot(att.round), 5));
        if (!f.twoSigMode()) return anchorSig;
        return bytes.concat(anchorSig, verifier.sign(OP_SEED, f.roundSigMessage(att.round, f.roundHash(att))));
    }

    function _post(PriceFeed f, RoundAttestation memory att) internal {
        f.postRound(att, _stateRoot(att.round), 5, _anchorSig(f, att));
    }

    /// @notice Post an honest round of four leaves and return them.
    function _postHonest(uint64 round, bool withOutlier)
        internal
        returns (RoundAttestation memory att, Leaf[] memory leaves, bytes[] memory sigs)
    {
        (leaves, sigs) = _leaves(feed, round, withOutlier);
        att = _att(round, leaves);
        _post(feed, att);
    }

    // ------------------------------------------------------------ hashing (test-side reference)

    function _leafHash(Leaf memory l) internal pure returns (bytes32) {
        return keccak256(abi.encode(l.round, l.scout, l.salt, l.feedIds, l.prices, l.commitSigHash));
    }

    function _hashes(Leaf[] memory leaves) internal pure returns (bytes32[] memory hs) {
        hs = new bytes32[](leaves.length);
        for (uint256 i = 0; i < leaves.length; i++) {
            hs[i] = _leafHash(leaves[i]);
        }
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _nextLevel(bytes32[] memory level) internal pure returns (bytes32[] memory next) {
        next = new bytes32[]((level.length + 1) / 2);
        for (uint256 i = 0; i < next.length; i++) {
            next[i] = 2 * i + 1 < level.length ? _pair(level[2 * i], level[2 * i + 1]) : level[2 * i];
        }
    }

    function _root(bytes32[] memory level) internal pure returns (bytes32) {
        if (level.length == 0) return bytes32(0);
        while (level.length > 1) {
            level = _nextLevel(level);
        }
        return level[0];
    }

    function _proof(bytes32[] memory level, uint256 idx) internal pure returns (bytes32[] memory proof) {
        bytes32[] memory tmp = new bytes32[](32);
        uint256 n;
        while (level.length > 1) {
            uint256 sib = idx ^ 1;
            if (sib < level.length) tmp[n++] = level[sib];
            level = _nextLevel(level);
            idx /= 2;
        }
        proof = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            proof[i] = tmp[i];
        }
    }

    function _median(uint128[] memory xs) internal pure returns (uint128) {
        for (uint256 i = 0; i < xs.length; i++) {
            for (uint256 j = i + 1; j < xs.length; j++) {
                if (xs[j] < xs[i]) (xs[i], xs[j]) = (xs[j], xs[i]);
            }
        }
        return xs[(xs.length - 1) / 2];
    }

    function _sortAddresses(address[] storage xs) internal {
        for (uint256 i = 0; i < xs.length; i++) {
            for (uint256 j = i + 1; j < xs.length; j++) {
                if (xs[j] < xs[i]) (xs[i], xs[j]) = (xs[j], xs[i]);
            }
        }
    }

    // ------------------------------------------------------------ signed bond actions

    function _exitSig(address who) internal view returns (bytes memory) {
        (,, uint64 nonce) = feed.bonds(who);
        return verifier.sign(seedOf[who], _qoreSign(feed.exitText(who, nonce)));
    }

    function _withdrawSig(address who, address to) internal view returns (bytes memory) {
        (,, uint64 nonce) = feed.bonds(who);
        return verifier.sign(seedOf[who], _qoreSign(feed.withdrawText(who, to, nonce)));
    }

    function _qoreSign(bytes memory text) internal pure returns (bytes memory) {
        return abi.encodePacked("qorechain-msg-v1|", CHAIN, "|", text);
    }
}
