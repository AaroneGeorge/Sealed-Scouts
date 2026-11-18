// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Stand-in for the QoreChain PQC precompiles in local tests (etched at 0x…0a01 and 0x…0a02).
/// @dev Two kinds of signature are valid:
///      1. Mock keys: pubkey and signature are keccak expansions of a secret seed, so only a test that holds the
///         seed can sign. Enough to test the contract's rules.
///      2. Allowed triples: exact (pubkey, signature, message) from the real ML-DSA-87 vectors. The contract must
///         rebuild the message byte for byte, or the lookup misses and verification fails.
///      Each call burns the gas the real precompile charges, so gas reports stay close to the chain's.
contract MockPqc {
    /// @dev The key bytes live in a data-only contract: reading 2.6 KB of storage would cost the mock ~170k gas,
    ///      while the real precompile charges 2,500. Reading code is close to the real price.
    struct Key {
        address blob;
        uint8 alg;
        bool proven;
    }

    uint256 internal constant SIG_BYTES = 4627;
    uint256 internal constant PUBKEY_BYTES = 2592;

    mapping(address => Key) internal _keys; // used at 0x…0a02
    mapping(bytes32 => bytes32) internal _seedOf; // keccak(pubkey) => seed, used at 0x…0a01
    mapping(bytes32 => bool) internal _allowed; // keccak(pubkey, sig, message), used at 0x…0a01

    function setKey(address account, bytes calldata pubkey, uint8 alg, bool proven) external {
        // Init code: copy everything after these 12 bytes and return it. A leading STOP keeps the blob uncallable.
        bytes memory init = abi.encodePacked(hex"61", uint16(pubkey.length + 1), hex"80600c6000396000f300", pubkey);
        address blob;
        assembly {
            blob := create(0, add(init, 32), mload(init))
        }
        require(blob != address(0), "blob");
        _keys[account] = Key(blob, alg, proven);
    }

    function addSeed(bytes32 seed) external returns (bytes memory pubkey) {
        pubkey = expand(keccak256(abi.encode("pub", seed)), PUBKEY_BYTES);
        _seedOf[keccak256(pubkey)] = seed;
    }

    function allow(bytes calldata pubkey, bytes calldata sig, bytes calldata message) external {
        _allowed[keccak256(abi.encode(pubkey, sig, message))] = true;
    }

    function pqcKeyStatus(address account) external view returns (bool, uint8, bytes memory, bool) {
        uint256 start = gasleft();
        Key storage k = _keys[account];
        bytes memory pubkey;
        if (k.blob != address(0)) {
            address blob = k.blob;
            uint256 len = blob.code.length - 1;
            pubkey = new bytes(len);
            assembly {
                extcodecopy(blob, add(pubkey, 32), 1, len)
            }
        }
        _burnUntil(start, 2_500);
        return (pubkey.length != 0, k.alg, pubkey, k.proven);
    }

    function pqcVerify(bytes calldata pubkey, bytes calldata sig, bytes calldata message)
        external
        view
        returns (bool ok)
    {
        uint256 start = gasleft();
        ok = _check(pubkey, sig, message);
        _burnUntil(start, 25_000 + 8 * msg.data.length);
    }

    function _check(bytes calldata pubkey, bytes calldata sig, bytes calldata message) private view returns (bool) {
        if (_allowed[keccak256(abi.encode(pubkey, sig, message))]) return true;
        bytes32 seed = _seedOf[keccak256(pubkey)];
        if (seed == bytes32(0) || sig.length != SIG_BYTES) return false;
        return keccak256(sig) == keccak256(sign(seed, message));
    }

    function sign(bytes32 seed, bytes memory message) public pure returns (bytes memory) {
        return expand(keccak256(abi.encode("sig", seed, message)), SIG_BYTES);
    }

    function expand(bytes32 seed, uint256 len) public pure returns (bytes memory out) {
        out = new bytes(len + 32); // room for the last whole word
        for (uint256 i = 0; i < len; i += 32) {
            bytes32 word = keccak256(abi.encode(seed, i));
            assembly {
                mstore(add(add(out, 32), i), word)
            }
        }
        assembly {
            mstore(add(add(out, 32), len), 0) // zero the tail so ABI padding stays clean
            mstore(out, len)
        }
    }

    /// @dev Pads the call up to the real precompile's price (work done so far counts toward it).
    function _burnUntil(uint256 start, uint256 cost) private view {
        while (start - gasleft() < cost) {}
    }
}
