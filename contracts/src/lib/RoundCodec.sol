// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice One price round as derived off chain from the rollup inbox (docs/SPEC.md, "Contract ABI").
struct RoundAttestation {
    uint64 round;
    uint64 batchIndex;
    uint64 inboxStart;
    uint64 inboxEnd;
    uint64 closeHeight;
    uint64 closeTime; // unix seconds
    uint16[] feedIds; // strictly ascending
    uint128[] medians; // 8 decimals
    uint8[] counts; // reports per feed, each >= quorum
    bytes32 reportsRoot;
    uint16 reportCount;
}

/// @notice One opened scout report, as committed under reportsRoot.
struct Leaf {
    uint64 round;
    address scout;
    bytes16 salt;
    uint16[] feedIds;
    uint128[] prices;
    bytes32 commitSigHash; // keccak256 of the scout's ML-DSA-87 COMMIT signature
}

/// @title RoundCodec
/// @notice Byte formats shared with packages/core. Every function here has a matching TypeScript function, and
///         the vector tests check both produce the same bytes.
library RoundCodec {
    bytes internal constant ANCHOR_DOMAIN = "qorechain-multilayer-anchor-v2";
    string internal constant ROUND_DOMAIN = "sealed-scouts/round/v1";
    bytes internal constant REPORT_DOMAIN = "sealed-scouts/report/v1";

    error MalformedLeaf();

    /// @notice keccak256(abi.encode("sealed-scouts/round/v1", uint256 evmChainId, string rollupId, att)). Goes into
    ///         the anchor's validator_set_hash slot, so the chain's own anchor signature covers the whole round.
    function roundHash(uint256 evmChainId, bytes memory rollupId, RoundAttestation calldata att)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(ROUND_DOMAIN, evmChainId, string(rollupId), att));
    }

    /// @notice The exact bytes the rollup creator signs for a batch anchor (RDK anchorSignBytesV2):
    ///         domain | len chainId | len layerId | batchIndex | len stateRoot | len vsh | txCount | len proof(empty).
    /// @dev The rollup's layer id equals its rollup id on QoreChain (checked on live rollups), so one string serves.
    function anchorBytes(
        bytes memory chainId,
        bytes memory layerId,
        uint64 batchIndex,
        bytes32 stateRoot,
        bytes memory vsh,
        uint64 txCount
    ) internal pure returns (bytes memory) {
        // Two halves: one packed call with twelve values runs out of stack in the legacy code generator.
        bytes memory head =
            abi.encodePacked(ANCHOR_DOMAIN, uint64(chainId.length), chainId, uint64(layerId.length), layerId);
        return bytes.concat(
            head, abi.encodePacked(batchIndex, uint64(32), stateRoot, uint64(vsh.length), vsh, txCount, uint64(0))
        );
    }

    function leafHash(Leaf calldata leaf) internal pure returns (bytes32) {
        return keccak256(abi.encode(leaf.round, leaf.scout, leaf.salt, leaf.feedIds, leaf.prices, leaf.commitSigHash));
    }

    /// @notice The scout's report commitment: SHA-256 over the big-endian report fields (docs/SPEC.md).
    function commitment(Leaf calldata leaf) internal pure returns (bytes32) {
        uint256 n = leaf.feedIds.length;
        if (n != leaf.prices.length || n > type(uint8).max) revert MalformedLeaf();
        bytes memory pairs;
        for (uint256 i = 0; i < n; i++) {
            pairs = bytes.concat(pairs, abi.encodePacked(leaf.feedIds[i], leaf.prices[i]));
        }
        return sha256(abi.encodePacked(REPORT_DOMAIN, leaf.round, leaf.scout, leaf.salt, uint8(n), pairs));
    }

    /// @notice Root of a tree whose parents hash the sorted pair; an odd last node moves up unchanged.
    /// @dev Overwrites `nodes`. Sorted pairs let a proof be a plain sibling list with no index.
    function merkleRoot(bytes32[] memory nodes) internal pure returns (bytes32) {
        uint256 n = nodes.length;
        if (n == 0) return bytes32(0);
        while (n > 1) {
            uint256 half = n / 2;
            for (uint256 i = 0; i < half; i++) {
                nodes[i] = _hashPair(nodes[2 * i], nodes[2 * i + 1]);
            }
            if (n % 2 == 1) nodes[half] = nodes[n - 1];
            n = half + (n % 2);
        }
        return nodes[0];
    }

    function verifyProof(bytes32[] calldata proof, bytes32 root, bytes32 leaf) internal pure returns (bool) {
        bytes32 node = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            node = _hashPair(node, proof[i]);
        }
        return node == root;
    }

    /// @notice Median and count of `feedId` over the given leaves: element floor((n-1)/2) of the sorted prices.
    /// @dev A leaf counts once, with the first price it lists for the feed. Leaves from another round or with
    ///      uneven arrays are skipped: they are not valid reports for this round (the caller treats them as fault).
    function medianOf(Leaf[] calldata leaves, uint64 round, uint16 feedId)
        internal
        pure
        returns (uint128 median, uint256 count)
    {
        uint128[] memory prices = new uint128[](leaves.length);
        for (uint256 i = 0; i < leaves.length; i++) {
            Leaf calldata leaf = leaves[i];
            if (leaf.round != round || leaf.feedIds.length != leaf.prices.length) continue;
            for (uint256 j = 0; j < leaf.feedIds.length; j++) {
                if (leaf.feedIds[j] == feedId) {
                    prices[count++] = leaf.prices[j];
                    break;
                }
            }
        }
        if (count == 0) return (0, 0);
        return (selectMedian(prices, count), count);
    }

    /// @notice Element floor((n-1)/2) of the first n values once sorted. Sorts in place (insertion sort: n is the
    ///         scout count, a handful).
    function selectMedian(uint128[] memory values, uint256 n) internal pure returns (uint128) {
        for (uint256 i = 1; i < n; i++) {
            uint128 v = values[i];
            uint256 j = i;
            while (j > 0 && values[j - 1] > v) {
                values[j] = values[j - 1];
                j--;
            }
            values[j] = v;
        }
        return values[(n - 1) / 2];
    }

    /// @notice True if `price` is more than `bps` basis points away from `median`: |p - m| * 10000 > bps * m.
    function beyond(uint256 price, uint256 median, uint256 bps) internal pure returns (bool) {
        uint256 diff = price > median ? price - median : median - price;
        return diff * 10_000 > bps * median;
    }

    function _hashPair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }
}
