// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {FeedFixture} from "./utils/FeedFixture.sol";
import {CodecHarness} from "./utils/CodecHarness.sol";
import {PriceFeed} from "../src/PriceFeed.sol";
import {RoundAttestation, Leaf} from "../src/lib/RoundCodec.sol";

/// @notice The contracts against packages/core's vectors (fixtures/vectors, fixtures/rounds). Signatures here are
///         real ML-DSA-87 signatures made by the TypeScript side; the mock precompile accepts each one only for the
///         exact (key, signature, message) triple in the file, so every signed byte the contract rebuilds must match.
contract VectorsTest is FeedFixture {
    CodecHarness internal codec = new CodecHarness();
    string internal constant VECTORS = "../fixtures/vectors/";
    uint256 internal constant EVM_CHAIN_ID = 9800;

    // ------------------------------------------------------------ fixtures/vectors

    function test_roundHashVectors() public {
        string memory json = vm.readFile(string.concat(VECTORS, "round-hash.json"));
        for (uint256 i = 0; i < 5; i++) {
            string memory c = string.concat(".cases[", vm.toString(i), "]");
            RoundAttestation memory att = _readAtt(json, string.concat(c, ".att"));
            uint256 chainId = vm.parseJsonUint(json, string.concat(c, ".chainId"));
            string memory rollupId = vm.parseJsonString(json, string.concat(c, ".rollupId"));
            bytes32 expected = vm.parseJsonBytes32(json, string.concat(c, ".roundHash"));
            assertEq(codec.roundHash(chainId, rollupId, att), expected, c);

            // The deployed feed uses block.chainid and its own rollup id.
            vm.chainId(chainId);
            PriceFeed f = new PriceFeed(operator, CHAIN, rollupId, false, WINDOW, EXIT_DELAY, MIN_BOND);
            assertEq(f.roundHash(att), expected, c);
        }
    }

    struct AnchorCase {
        string chainId;
        string layerId;
        uint64 batchIndex;
        bytes32 stateRoot;
        bytes vsh;
        uint64 txCount;
        bytes signBytes;
        bytes sig;
        string roundHashCase;
    }

    function test_anchorVectorsAndRealSignatures() public {
        string memory json = vm.readFile(string.concat(VECTORS, "anchor.json"));
        bytes memory pubkey = vm.parseJsonBytes(json, ".publicKey");
        keyStatus.setKey(operator, pubkey, 1, true);
        for (uint256 i = 0; i < 5; i++) {
            AnchorCase memory a = _readAnchor(json, string.concat(".cases[", vm.toString(i), "]"));
            assertEq(codec.anchorBytes(a.chainId, a.layerId, a.batchIndex, a.stateRoot, a.vsh, a.txCount), a.signBytes);
            assertEq(a.signBytes.length, 165 + bytes(a.layerId).length); // 180 for "sealed-scouts-1"
            verifier.allow(pubkey, a.sig, a.signBytes);
            _checkAnchorOnFeed(a);
        }
    }

    /// @dev Where the vector's attestation names the same batch, the feed checks the real signature end to end.
    function _checkAnchorOnFeed(AnchorCase memory a) internal {
        string memory rh = vm.readFile(string.concat(VECTORS, "round-hash.json"));
        string memory rc = _caseByName(rh, a.roundHashCase);
        RoundAttestation memory att = _readAtt(rh, string.concat(rc, ".att"));
        if (att.batchIndex != a.batchIndex) return;
        vm.chainId(vm.parseJsonUint(rh, string.concat(rc, ".chainId")));
        string memory rollupId = vm.parseJsonString(rh, string.concat(rc, ".rollupId"));
        PriceFeed f = new PriceFeed(operator, CHAIN, rollupId, false, WINDOW, EXIT_DELAY, MIN_BOND);

        assertEq(f.anchorBytes(att, a.stateRoot, a.txCount), a.signBytes, a.roundHashCase);
        assertTrue(f.verifyReceipt(att, a.stateRoot, a.txCount, a.sig), a.roundHashCase);
        a.sig[7] ^= 0x01;
        assertFalse(f.verifyReceipt(att, a.stateRoot, a.txCount, a.sig), a.roundHashCase);
        a.sig[7] ^= 0x01;

        if (att.feedIds.length > 0 && att.closeTime < block.timestamp) {
            f.bondOperator{value: MIN_BOND}();
            f.postRound(att, a.stateRoot, a.txCount, a.sig);
            assertEq(uint8(f.status(att.round)), uint8(PriceFeed.Status.Pending));
        }
    }

    function _readAnchor(string memory json, string memory c) internal pure returns (AnchorCase memory a) {
        a.chainId = vm.parseJsonString(json, string.concat(c, ".chainId"));
        a.layerId = vm.parseJsonString(json, string.concat(c, ".layerId"));
        a.batchIndex = uint64(vm.parseJsonUint(json, string.concat(c, ".batchIndex")));
        a.stateRoot = vm.parseJsonBytes32(json, string.concat(c, ".stateRoot"));
        a.vsh = vm.parseJsonBytes(json, string.concat(c, ".validatorSetHash"));
        a.txCount = uint64(vm.parseJsonUint(json, string.concat(c, ".txCount")));
        a.signBytes = vm.parseJsonBytes(json, string.concat(c, ".signBytes"));
        a.sig = vm.parseJsonBytes(json, string.concat(c, ".signature"));
        a.roundHashCase = vm.parseJsonString(json, string.concat(c, ".roundHashCase"));
    }

    function test_merkleVectors() public view {
        string memory json = vm.readFile(string.concat(VECTORS, "merkle.json"));
        for (uint256 t = 0; t < 4; t++) {
            string memory tp = string.concat(".trees[", vm.toString(t), "]");
            uint256 size = vm.parseJsonUint(json, string.concat(tp, ".size"));
            bytes32 root = vm.parseJsonBytes32(json, string.concat(tp, ".root"));
            bytes32[] memory hashes = new bytes32[](size);
            for (uint256 i = 0; i < size; i++) {
                string memory lp = string.concat(tp, ".leaves[", vm.toString(i), "]");
                hashes[i] = codec.leafHash(_readLeaf(json, lp));
                assertEq(hashes[i], vm.parseJsonBytes32(json, string.concat(lp, ".leafHash")), lp);
                bytes32[] memory proof = vm.parseJsonBytes32Array(json, string.concat(lp, ".proof"));
                assertTrue(codec.verifyProof(proof, root, hashes[i]), lp);
            }
            assertEq(codec.merkleRoot(hashes), root, tp);
        }
    }

    function test_medianAndBandVectors() public view {
        string memory json = vm.readFile(string.concat(VECTORS, "median.json"));
        for (uint256 i = 0; i < 7; i++) {
            string memory c = string.concat(".medians[", vm.toString(i), "]");
            uint256[] memory raw = vm.parseJsonUintArray(json, string.concat(c, ".values"));
            uint128[] memory values = new uint128[](raw.length);
            for (uint256 j = 0; j < raw.length; j++) {
                values[j] = uint128(raw[j]);
            }
            assertEq(codec.selectMedian(values), vm.parseJsonUint(json, string.concat(c, ".median")), c);
        }
        for (uint256 i = 0; i < 9; i++) {
            string memory c = string.concat(".bands[", vm.toString(i), "]");
            uint256 price = vm.parseJsonUint(json, string.concat(c, ".price"));
            uint256 median = vm.parseJsonUint(json, string.concat(c, ".median"));
            bool outlier = vm.parseJsonBool(json, string.concat(c, ".outlier"));
            assertEq(codec.beyond(price, median, feed.SLASH_BPS()), outlier, c);
        }
    }

    function test_commitVectors() public {
        string memory json = vm.readFile(string.concat(VECTORS, "commit.json"));
        vm.chainId(EVM_CHAIN_ID);
        for (uint256 i = 0; i < 3; i++) {
            string memory c = string.concat(".cases[", vm.toString(i), "]");
            Leaf memory leaf = _readLeaf(json, c);
            bytes memory sig = vm.parseJsonBytes(json, string.concat(c, ".signature"));
            bytes memory signBytes = vm.parseJsonBytes(json, string.concat(c, ".signBytes"));
            assertEq(codec.commitment(leaf), vm.parseJsonBytes32(json, string.concat(c, ".commitment")), c);
            assertEq(codec.bech32Qor(leaf.scout), vm.parseJsonString(json, string.concat(c, ".scoutQor")), c);
            assertEq(feed.commitMessage(leaf), signBytes, c);
            assertEq(keccak256(sig), leaf.commitSigHash, c);
        }
    }

    function test_textEncodings() public view {
        assertEq(codec.bech32Qor(address(1)), "qor1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp67rf0d");
        assertEq(
            codec.bech32Qor(0x7F806B5bF878a7b89d7F7d0b4ec3a517A38d15C7), "qor107qxkklc0znm38tl0595asa9z73c69w85tsztr"
        );
        assertEq(codec.decimal(0), "0");
        assertEq(codec.decimal(18446744073709551615), "18446744073709551615");
        assertEq(
            codec.hexAddress(0x7F806B5bF878a7b89d7F7d0b4ec3a517A38d15C7), "0x7f806b5bf878a7b89d7f7d0b4ec3a517a38d15c7"
        );
    }

    // ------------------------------------------------------------ fixtures/rounds: end to end with real COMMIT sigs

    /// @notice Fixture round 02: scout5 reports fETH 15% high. After the round settles, the court slashes it with
    ///         the ML-DSA-87 signature it really posted in its COMMIT entry.
    function test_fixtureOutlierSlashedWithRealCommitSignature() public {
        string memory json = vm.readFile("../fixtures/rounds/02-outlier.json");
        (PriceFeed f, Leaf[] memory leaves, RoundAttestation memory att) = _postFixture(json, false);

        Leaf memory outlier = _readLeaf(json, ".expected.outliers[0]");
        uint256 idx = type(uint256).max;
        for (uint256 i = 0; i < leaves.length; i++) {
            if (leaves[i].scout == outlier.scout) idx = i;
        }
        string memory qor = codec.bech32Qor(outlier.scout);
        (bytes32 commitment, bytes memory sig) = _commitEntry(json, qor);
        assertEq(keccak256(sig), outlier.commitSigHash);

        // The message, rebuilt here from the fixture's own bytes (not by the contract).
        bytes memory message = abi.encodePacked(
            "qorechain-msg-v1|qorechain-diana|sealed-scouts/commit/v1|",
            vm.parseJsonString(json, ".params.rollupId"),
            "|",
            vm.toString(uint256(att.round)),
            "|",
            qor,
            "|",
            _no0x(vm.toString(commitment))
        );
        bytes memory pubkey = _scoutKey(outlier.scout);
        keyStatus.setKey(outlier.scout, pubkey, 1, true);
        verifier.allow(pubkey, sig, message);
        f.bondFor{value: SCOUT_BOND}(outlier.scout);

        vm.warp(block.timestamp + WINDOW);
        f.slashOutlier(att.round, outlier, _proof(_hashes(leaves), idx), sig);
        (uint128 bond,,) = f.bonds(outlier.scout);
        assertEq(bond, 0);
    }

    /// @notice Fixture round 01 (honest): the true attestation cannot be challenged; a lie in it is slashed.
    function test_fixtureCourt() public {
        string memory json = vm.readFile("../fixtures/rounds/01-honest.json");
        (PriceFeed honest, Leaf[] memory leaves, RoundAttestation memory att) = _postFixture(json, false);
        vm.expectRevert(abi.encodeWithSelector(PriceFeed.HonestRound.selector, att.round));
        honest.challengeMedian(att.round, leaves);

        (PriceFeed lied,,) = _postFixture(json, true);
        lied.challengeMedian(att.round, leaves);
        (uint128 price,,, uint8 status) = lied.latest(att.feedIds[0]);
        assertEq(price, att.medians[0]);
        assertEq(status, uint8(PriceFeed.Status.Corrected));
    }

    // ------------------------------------------------------------ helpers

    /// @dev Deploys a feed for the fixture's rollup, posts the fixture's expected round (operator signs with the mock
    ///      key: real anchor signatures are covered by test_anchorVectorsAndRealSignatures) and returns its leaves.
    function _postFixture(string memory json, bool lie)
        internal
        returns (PriceFeed f, Leaf[] memory leaves, RoundAttestation memory att)
    {
        vm.chainId(EVM_CHAIN_ID);
        f = new PriceFeed(
            operator, CHAIN, vm.parseJsonString(json, ".params.rollupId"), false, WINDOW, EXIT_DELAY, MIN_BOND
        );
        f.bondOperator{value: OP_BOND}();

        uint256 n = _count(json, ".expected.leaves");
        leaves = new Leaf[](n);
        for (uint256 i = 0; i < n; i++) {
            leaves[i] = _readLeaf(json, string.concat(".expected.leaves[", vm.toString(i), "]"));
        }
        uint256 feeds = _count(json, ".expected.medians");
        att.round = uint64(vm.parseJsonUint(json, ".expected.round"));
        att.batchIndex = 1;
        att.inboxStart = 1;
        att.inboxEnd = 20;
        att.closeHeight = uint64(vm.parseJsonUint(json, ".expected.closeHeight"));
        att.closeTime = uint64(block.timestamp) - 10;
        att.feedIds = new uint16[](feeds);
        att.medians = new uint128[](feeds);
        att.counts = new uint8[](feeds);
        for (uint256 k = 0; k < feeds; k++) {
            string memory m = string.concat(".expected.medians[", vm.toString(k), "]");
            att.feedIds[k] = uint16(vm.parseJsonUint(json, string.concat(m, ".feedId")));
            att.medians[k] = uint128(vm.parseJsonUint(json, string.concat(m, ".price")));
            att.counts[k] = uint8(vm.parseJsonUint(json, string.concat(m, ".count")));
        }
        att.reportsRoot = vm.parseJsonBytes32(json, ".expected.reportsRoot");
        att.reportCount = uint16(n);
        assertEq(_root(_hashes(leaves)), att.reportsRoot); // our reference tree agrees with core's
        if (lie) att.medians[0] += 1;
        _post(f, att);
    }

    /// @dev The COMMIT entry posted by `qor`: "SSC1" | 0x03 | round u64 | commitment 32 | signature 4627.
    function _commitEntry(string memory json, string memory qor)
        internal
        view
        returns (bytes32 commitment, bytes memory sig)
    {
        uint256 n = _count(json, ".entries");
        for (uint256 i = 0; i < n; i++) {
            string memory e = string.concat(".entries[", vm.toString(i), "]");
            bytes memory payload = vm.parseJsonBytes(json, string.concat(e, ".payload"));
            if (payload.length != 4672 || payload[4] != 0x03) continue;
            if (keccak256(bytes(vm.parseJsonString(json, string.concat(e, ".poster")))) != keccak256(bytes(qor))) {
                continue;
            }
            assembly {
                commitment := mload(add(payload, 45)) // 32 (length word) + 13 (SSC1, kind, round)
            }
            sig = new bytes(4627);
            for (uint256 j = 0; j < 4627; j++) {
                sig[j] = payload[45 + j];
            }
            return (commitment, sig);
        }
        revert("no COMMIT entry");
    }

    function _scoutKey(address scout) internal view returns (bytes memory) {
        string memory json = vm.readFile("../fixtures/scouts.json");
        for (uint256 i = 0; i < 10; i++) {
            string memory s = string.concat(".scouts[", vm.toString(i), "]");
            if (vm.parseJsonAddress(json, string.concat(s, ".address")) == scout) {
                return vm.parseJsonBytes(json, string.concat(s, ".publicKey"));
            }
        }
        revert("unknown scout");
    }

    function _caseByName(string memory json, string memory name) internal pure returns (string memory) {
        for (uint256 i = 0; i < 5; i++) {
            string memory c = string.concat(".cases[", vm.toString(i), "]");
            if (keccak256(bytes(vm.parseJsonString(json, string.concat(c, ".name")))) == keccak256(bytes(name))) {
                return c;
            }
        }
        revert("no such case");
    }

    function _readAtt(string memory json, string memory p) internal pure returns (RoundAttestation memory att) {
        att.round = uint64(vm.parseJsonUint(json, string.concat(p, ".round")));
        att.batchIndex = uint64(vm.parseJsonUint(json, string.concat(p, ".batchIndex")));
        att.inboxStart = uint64(vm.parseJsonUint(json, string.concat(p, ".inboxStart")));
        att.inboxEnd = uint64(vm.parseJsonUint(json, string.concat(p, ".inboxEnd")));
        att.closeHeight = uint64(vm.parseJsonUint(json, string.concat(p, ".closeHeight")));
        att.closeTime = uint64(vm.parseJsonUint(json, string.concat(p, ".closeTime")));
        uint256[] memory ids = vm.parseJsonUintArray(json, string.concat(p, ".feedIds"));
        uint256[] memory medians = vm.parseJsonUintArray(json, string.concat(p, ".medians"));
        uint256[] memory counts = vm.parseJsonUintArray(json, string.concat(p, ".counts"));
        att.feedIds = new uint16[](ids.length);
        att.medians = new uint128[](ids.length);
        att.counts = new uint8[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            att.feedIds[i] = uint16(ids[i]);
            att.medians[i] = uint128(medians[i]);
            att.counts[i] = uint8(counts[i]);
        }
        att.reportsRoot = vm.parseJsonBytes32(json, string.concat(p, ".reportsRoot"));
        att.reportCount = uint16(vm.parseJsonUint(json, string.concat(p, ".reportCount")));
    }

    function _readLeaf(string memory json, string memory p) internal pure returns (Leaf memory leaf) {
        leaf.round = uint64(vm.parseJsonUint(json, string.concat(p, ".round")));
        leaf.scout = vm.parseJsonAddress(json, string.concat(p, ".scout"));
        leaf.salt = bytes16(vm.parseJsonBytes(json, string.concat(p, ".salt")));
        uint256[] memory ids = vm.parseJsonUintArray(json, string.concat(p, ".feedIds"));
        uint256[] memory prices = vm.parseJsonUintArray(json, string.concat(p, ".prices"));
        leaf.feedIds = new uint16[](ids.length);
        leaf.prices = new uint128[](prices.length);
        for (uint256 i = 0; i < ids.length; i++) {
            leaf.feedIds[i] = uint16(ids[i]);
            leaf.prices[i] = uint128(prices[i]);
        }
        leaf.commitSigHash = vm.parseJsonBytes32(json, string.concat(p, ".commitSigHash"));
    }

    function _count(string memory json, string memory array) internal view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(array, "[", vm.toString(n), "]"))) {
            n++;
        }
    }

    function _no0x(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(b.length - 2);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = b[i + 2];
        }
        return string(out);
    }
}
