// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RoundAttestation, Leaf, RoundCodec} from "../../src/lib/RoundCodec.sol";
import {Text} from "../../src/lib/Text.sol";

/// @notice Exposes the internal codec functions so vector tests can call them one by one.
contract CodecHarness {
    function roundHash(uint256 chainId, string calldata rollupId, RoundAttestation calldata att)
        external
        pure
        returns (bytes32)
    {
        return RoundCodec.roundHash(chainId, bytes(rollupId), att);
    }

    function anchorBytes(
        string calldata chainId,
        string calldata layerId,
        uint64 batchIndex,
        bytes32 stateRoot,
        bytes calldata vsh,
        uint64 txCount
    ) external pure returns (bytes memory) {
        return RoundCodec.anchorBytes(bytes(chainId), bytes(layerId), batchIndex, stateRoot, vsh, txCount);
    }

    function leafHash(Leaf calldata leaf) external pure returns (bytes32) {
        return RoundCodec.leafHash(leaf);
    }

    function commitment(Leaf calldata leaf) external pure returns (bytes32) {
        return RoundCodec.commitment(leaf);
    }

    function merkleRoot(bytes32[] memory hashes) external pure returns (bytes32) {
        return RoundCodec.merkleRoot(hashes);
    }

    function verifyProof(bytes32[] calldata proof, bytes32 root, bytes32 leaf) external pure returns (bool) {
        return RoundCodec.verifyProof(proof, root, leaf);
    }

    function selectMedian(uint128[] memory values) external pure returns (uint128) {
        return RoundCodec.selectMedian(values, values.length);
    }

    function medianOf(Leaf[] calldata leaves, uint64 round, uint16 feedId) external pure returns (uint128, uint256) {
        return RoundCodec.medianOf(leaves, round, feedId);
    }

    function beyond(uint256 price, uint256 median, uint256 bps) external pure returns (bool) {
        return RoundCodec.beyond(price, median, bps);
    }

    function bech32Qor(address account) external pure returns (string memory) {
        return string(Text.bech32Qor(account));
    }

    function decimal(uint256 value) external pure returns (string memory) {
        return string(Text.decimal(value));
    }

    function hexAddress(address account) external pure returns (string memory) {
        return string(Text.hexAddress(account));
    }
}
