// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Text
/// @notice The few string encodings that signed messages need: decimal, lowercase hex, and bech32 "qor1" addresses.
/// @dev Signed texts must be rebuilt byte for byte on chain, so these follow the TypeScript side exactly:
///      no leading zeros in decimals, lowercase hex, BIP-173 bech32 (not bech32m).
library Text {
    bytes16 private constant HEX = "0123456789abcdef";
    bytes32 private constant BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

    error StringTooLong();

    function decimal(uint256 value) internal pure returns (bytes memory out) {
        if (value == 0) return "0";
        uint256 digits;
        for (uint256 v = value; v != 0; v /= 10) {
            digits++;
        }
        out = new bytes(digits);
        for (uint256 i = digits; i > 0; value /= 10) {
            out[--i] = bytes1(uint8(48 + (value % 10)));
        }
    }

    /// @notice 64 lowercase hex characters, no 0x.
    function hex32(bytes32 value) internal pure returns (bytes memory out) {
        out = new bytes(64);
        for (uint256 i = 0; i < 32; i++) {
            uint8 b = uint8(value[i]);
            out[2 * i] = HEX[b >> 4];
            out[2 * i + 1] = HEX[b & 0x0f];
        }
    }

    /// @notice "0x" + 40 lowercase hex characters (not EIP-55: checksummed case would be one more thing to match).
    function hexAddress(address account) internal pure returns (bytes memory out) {
        out = new bytes(42);
        out[0] = "0";
        out[1] = "x";
        uint160 v = uint160(account);
        for (uint256 i = 41; i > 1; i--) {
            out[i] = HEX[v & 0x0f];
            v >>= 4;
        }
    }

    /// @notice The native "qor1…" form of an EVM address (same 20 bytes, bech32 with hrp "qor").
    function bech32Qor(address account) internal pure returns (bytes memory out) {
        // 160 bits split into exactly 32 five-bit groups, so no padding is needed.
        uint8[32] memory data;
        uint160 v = uint160(account);
        for (uint256 i = 0; i < 32; i++) {
            data[i] = uint8((v >> (155 - 5 * i)) & 31);
        }
        // Checksum over the expanded hrp "qor": high bits, 0, low bits.
        uint256 chk = 1;
        bytes3 hrp = "qor";
        for (uint256 i = 0; i < 3; i++) {
            chk = _polymodStep(chk, uint8(hrp[i]) >> 5);
        }
        chk = _polymodStep(chk, 0);
        for (uint256 i = 0; i < 3; i++) {
            chk = _polymodStep(chk, uint8(hrp[i]) & 31);
        }
        for (uint256 i = 0; i < 32; i++) {
            chk = _polymodStep(chk, data[i]);
        }
        for (uint256 i = 0; i < 6; i++) {
            chk = _polymodStep(chk, 0);
        }
        chk ^= 1;

        out = new bytes(42);
        out[0] = "q";
        out[1] = "o";
        out[2] = "r";
        out[3] = "1";
        for (uint256 i = 0; i < 32; i++) {
            out[4 + i] = BECH32[data[i]];
        }
        for (uint256 i = 0; i < 6; i++) {
            out[36 + i] = BECH32[(chk >> (5 * (5 - i))) & 31];
        }
    }

    function _polymodStep(uint256 chk, uint256 value) private pure returns (uint256) {
        uint256 top = chk >> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ value;
        if (top & 1 != 0) chk ^= 0x3b6a57b2;
        if (top & 2 != 0) chk ^= 0x26508e6d;
        if (top & 4 != 0) chk ^= 0x1ea119fa;
        if (top & 8 != 0) chk ^= 0x3d4233dd;
        if (top & 16 != 0) chk ^= 0x2a1462b3;
        return chk;
    }

    /// @notice Packs a string of up to 31 bytes into one word (length in the last byte), so config strings can be
    ///         immutables instead of storage reads on every round.
    function pack(string memory s) internal pure returns (bytes32 word) {
        bytes memory b = bytes(s);
        if (b.length > 31) revert StringTooLong();
        word = bytes32(b) | bytes32(b.length);
    }

    function unpack(bytes32 word) internal pure returns (bytes memory out) {
        uint256 len = uint256(word) & 0xff;
        out = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            out[i] = word[i];
        }
    }
}
