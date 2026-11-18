// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice QoreChain PQC Verify precompile (testnet only; see LIMITS.md L1).
interface IPqcVerify {
    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external
        view
        returns (bool valid);
}

/// @notice QoreChain PQC Key Status precompile.
interface IPqcKeyStatus {
    function pqcKeyStatus(address account)
        external
        view
        returns (bool registered, uint8 algorithmId, bytes memory pubkey, bool possessionProven);
}

/// @title Pqc
/// @notice ML-DSA-87 checks through the QoreChain precompiles.
/// @dev Calls go through typed interfaces on purpose: an inactive precompile answers with empty data, and
///      abi-decoding empty data reverts. So on a chain without the precompiles every check fails closed.
library Pqc {
    IPqcVerify internal constant VERIFY = IPqcVerify(address(uint160(0x0a01)));
    IPqcKeyStatus internal constant KEY_STATUS = IPqcKeyStatus(address(uint160(0x0a02)));

    uint8 internal constant ML_DSA_87 = 1;
    uint256 internal constant PUBKEY_BYTES = 2592;
    uint256 internal constant SIG_BYTES = 4627;

    /// @dev QoreSign message v1: wallets sign this prefix + text, never raw bytes, so a message signature can never
    ///      be replayed as a transaction. Bots use the same format so a person with a wallet could sign too.
    bytes internal constant MESSAGE_DOMAIN = "qorechain-msg-v1|";

    /// @notice The account's ML-DSA-87 key, read from the chain at call time (so a key rotation applies at once).
    /// @return ok False unless the key is registered, ML-DSA-87, full length, and proven by proof of possession.
    ///         Without the proof anyone could register someone else's key under their own address.
    function keyOf(address account) internal view returns (bool ok, bytes memory pubkey) {
        (bool registered, uint8 alg, bytes memory key, bool proven) = KEY_STATUS.pqcKeyStatus(account);
        ok = registered && proven && alg == ML_DSA_87 && key.length == PUBKEY_BYTES;
        pubkey = key;
    }

    /// @notice True only for a valid ML-DSA-87 signature of exactly the expected length.
    function verify(bytes memory pubkey, bytes calldata signature, bytes memory message) internal view returns (bool) {
        if (signature.length != SIG_BYTES) return false;
        return VERIFY.pqcVerify(pubkey, signature, message);
    }

    /// @notice The bytes a QoreSign v1 wallet signs for `text` on `nativeChainId`.
    function messageBytes(bytes memory nativeChainId, bytes memory text) internal pure returns (bytes memory) {
        return abi.encodePacked(MESSAGE_DOMAIN, nativeChainId, "|", text);
    }
}
