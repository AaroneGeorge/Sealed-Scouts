// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IPqcVerify {
    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message) external view returns (bool);
}

interface IPqcKeyStatus {
    function pqcKeyStatus(address account)
        external
        view
        returns (bool registered, uint8 algorithmId, bytes memory pubkey, bool possessionProven);
}

/// Day-1 probe: checks a live settlement anchor signature on chain, reading the signer's key from the
/// registry precompile, and records the gas the check took. Used once to measure real costs.
contract AnchorProbe {
    IPqcVerify internal constant PQC_VERIFY = IPqcVerify(0x0000000000000000000000000000000000000a01);
    IPqcKeyStatus internal constant PQC_KEY_STATUS = IPqcKeyStatus(0x0000000000000000000000000000000000000a02);

    event AnchorChecked(address indexed creator, bool valid, uint256 gasForCheck);

    function verifyAnchor(address creator, bytes calldata anchorBytes, bytes calldata signature)
        public
        view
        returns (bool)
    {
        (bool registered,, bytes memory pubkey,) = PQC_KEY_STATUS.pqcKeyStatus(creator);
        require(registered, "creator has no PQC key");
        return PQC_VERIFY.pqcVerify(pubkey, signature, anchorBytes);
    }

    function checkAnchor(address creator, bytes calldata anchorBytes, bytes calldata signature) external returns (bool valid) {
        uint256 start = gasleft();
        valid = verifyAnchor(creator, anchorBytes, signature);
        emit AnchorChecked(creator, valid, start - gasleft());
    }
}
