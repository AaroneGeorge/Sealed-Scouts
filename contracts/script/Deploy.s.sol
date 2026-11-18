// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PriceFeed} from "../src/PriceFeed.sol";
import {ScoutLend, IFinalPrice, IERC20Min} from "../src/ScoutLend.sol";

/// @notice Deploys PriceFeed and ScoutLend and records their addresses under "contracts" in the deployments file.
///         The file belongs to the operator launch: this script reads rollupId, operatorEvm and evmChainId from it
///         and writes only the "contracts" key, keeping every other key. Env vars override what the file says.
///         On diana an EVM window must be open for the deployer first (see contracts/README.md).
contract Deploy is Script {
    // Fest test tokens on diana (docs.qorechain.io, dashboard/faucet).
    address internal constant FETH = 0x02292293c13880a26242690eb70a0e42B8E91c28;
    address internal constant FUSD = 0x97143B771D34ddb9130b807b135Ae675A5a963CA;

    struct Config {
        address operator;
        string nativeChainId;
        string rollupId;
        bool twoSig;
        uint64 window;
        uint64 exitDelay;
        uint128 minBond;
        address feth;
        address fusd;
        uint16 ltvBps;
        uint16 liqBps;
        uint64 maxAge;
        string file;
    }

    function run() external returns (PriceFeed feed, ScoutLend lend) {
        Config memory c = _config();
        vm.startBroadcast();
        feed = new PriceFeed(c.operator, c.nativeChainId, c.rollupId, c.twoSig, c.window, c.exitDelay, c.minBond);
        lend = new ScoutLend(
            IFinalPrice(address(feed)), IERC20Min(c.feth), IERC20Min(c.fusd), 1, 3, c.ltvBps, c.liqBps, c.maxAge
        );
        vm.stopBroadcast();
        _record(c, address(feed), address(lend));
        console2.log("PriceFeed", address(feed));
        console2.log("ScoutLend", address(lend));
        console2.log("written to", c.file);
    }

    function _config() internal view returns (Config memory c) {
        c.file = vm.envOr("SS_DEPLOYMENTS_FILE", string("../deployments/diana.json"));
        string memory d = vm.exists(c.file) ? vm.readFile(c.file) : "{}";
        c.operator = vm.envOr("SS_OPERATOR", _fileAddress(d, ".operatorEvm"));
        c.rollupId = vm.envOr("SS_ROLLUP_ID", _fileString(d, ".rollupId", "sealed-scouts-1"));
        c.nativeChainId = vm.envOr("SS_NATIVE_CHAIN_ID", _fileString(d, ".chainId", "qorechain-diana"));
        require(c.operator != address(0), "operator unknown: set SS_OPERATOR or operatorEvm in the deployments file");
        if (vm.keyExistsJson(d, ".evmChainId")) {
            require(vm.parseJsonUint(d, ".evmChainId") == block.chainid, "deployments file is for another chain");
        }
        c.twoSig = vm.envOr("SS_TWO_SIG", false);
        c.window = uint64(vm.envOr("SS_CHALLENGE_WINDOW", uint256(120)));
        c.exitDelay = uint64(vm.envOr("SS_EXIT_DELAY", uint256(300)));
        c.minBond = uint128(vm.envOr("SS_MIN_OPERATOR_BOND", uint256(10 ether)));
        c.feth = vm.envOr("SS_FETH", FETH);
        c.fusd = vm.envOr("SS_FUSD", FUSD);
        c.ltvBps = uint16(vm.envOr("SS_LTV_BPS", uint256(5000)));
        c.liqBps = uint16(vm.envOr("SS_LIQ_BPS", uint256(8000)));
        // A round lasts about 6.5 minutes plus the window, so 15 minutes keeps one round of slack.
        c.maxAge = uint64(vm.envOr("SS_MAX_PRICE_AGE", uint256(900)));
    }

    function _fileString(string memory d, string memory key, string memory fallback_)
        internal
        view
        returns (string memory)
    {
        return vm.keyExistsJson(d, key) ? vm.parseJsonString(d, key) : fallback_;
    }

    function _fileAddress(string memory d, string memory key) internal view returns (address) {
        return vm.keyExistsJson(d, key) ? vm.parseJsonAddress(d, key) : address(0);
    }

    /// @dev Writes only "contracts"; vm.writeJson with a key replaces (or adds) that key and keeps the rest.
    function _record(Config memory c, address feed, address lend) internal {
        if (!vm.exists(c.file)) vm.writeFile(c.file, "{}");
        vm.serializeAddress("contracts", "PriceFeed", feed);
        string memory json = vm.serializeAddress("contracts", "ScoutLend", lend);
        vm.writeJson(json, c.file, ".contracts");
    }
}
