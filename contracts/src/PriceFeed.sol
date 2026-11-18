// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Pqc} from "./lib/Pqc.sol";
import {RoundAttestation, Leaf, RoundCodec} from "./lib/RoundCodec.sol";
import {Text} from "./lib/Text.sol";

/// @title PriceFeed
/// @notice Price rounds from the Sealed Scouts rollup. A round is accepted only with the rollup creator's ML-DSA-87
///         anchor signature, sits Pending for a challenge window, and then turns Final. During the window anyone can
///         prove a wrong median from the committed reports; the contract then corrects the price and slashes the
///         operator bond.
/// @dev No function trusts msg.sender. Every power over a bond needs an ML-DSA-87 signature from the key the chain
///      has registered for that address, so a stolen classical (ECDSA) key is worth nothing here.
contract PriceFeed {
    enum Status {
        None,
        Pending,
        Final,
        Corrected // fixed by the court; final at once
    }

    struct Round {
        bytes32 reportsRoot;
        uint64 postedAt;
        uint64 closeTime;
        uint64 batchIndex;
        uint16 reportCount;
        bool corrected;
    }

    struct FeedPoint {
        uint128 price;
        uint8 count;
        bool listed; // the round carried this feed (a corrected price can be 0: no quorum)
    }

    /// @dev The two newest rounds per feed, so a reader can use the last final round while a newer one is pending.
    struct FeedHead {
        uint64 latest;
        uint64 prev;
    }

    struct Bond {
        uint128 amount;
        uint64 exitAt; // 0 = not exiting
        uint64 nonce; // bumps on every signed exit action, so a signature works once
    }

    struct Cursor {
        uint64 lastRound;
        uint64 lastBatchIndex;
        bool started;
    }

    uint256 public constant QUORUM = 3;
    uint256 public constant SLASH_BPS = 1000; // a report further than 10% from the median is slashable

    /// @notice The rollup creator: signs anchors, posts rounds, holds the operator bond.
    address public immutable operator;
    /// @notice Two-signature mode: the anchor carries no round hash, so the operator also signs the round itself.
    bool public immutable twoSigMode;
    uint64 public immutable challengeWindow;
    uint64 public immutable exitDelay;
    uint128 public immutable minOperatorBond;
    bytes32 private immutable _nativeChainId;
    bytes32 private immutable _rollupId;

    mapping(uint64 => Round) public rounds;
    mapping(uint64 => uint16[]) private _roundFeeds;
    mapping(uint64 => mapping(uint16 => FeedPoint)) public points;
    mapping(uint16 => FeedHead) public heads;
    mapping(address => Bond) public bonds;
    mapping(uint64 => mapping(address => bool)) public outlierSlashed;
    Cursor public cursor;
    /// @notice Sum of all bonds. Together with totalBurned it accounts for every wei this contract holds.
    uint256 public totalBonded;
    /// @notice Slashed funds that nobody can ever withdraw.
    uint256 public totalBurned;

    event RoundPosted(
        uint64 indexed round,
        bytes32 roundHash,
        bytes32 stateRoot,
        uint64 txCount,
        RoundAttestation att,
        bytes anchorSig
    );
    event MedianCorrected(
        uint64 indexed round, address indexed challenger, uint16[] feedIds, uint128[] medians, uint8[] counts
    );
    event ScoutSlashed(uint64 indexed round, address indexed scout, address indexed challenger, bytes scoutSig);
    event Slashed(address indexed who, address indexed to, uint256 reward, uint256 burned);
    event Bonded(address indexed who, address indexed from, uint256 amount, uint256 total);
    event ExitRequested(address indexed who, uint64 exitAt, bytes pqSig);
    event BondWithdrawn(address indexed who, address indexed to, uint256 amount, bytes pqSig);

    error BadConfig();
    error BadAttestation();
    error StaleRound();
    error OperatorNotBonded();
    error NoPqKey(address account);
    error BadSignature();
    error NotPending(uint64 round);
    error NotFinal(uint64 round);
    error LeavesNotSorted();
    error RootMismatch();
    error HonestRound(uint64 round);
    error NotInRound();
    error SigNotCommitted();
    error NotOutlier();
    error AlreadySlashed();
    error NothingBonded();
    error AlreadyExiting();
    error ExitNotReady();
    error ZeroValue();
    error PayFailed();
    error NoFinalPrice(uint16 feedId);
    error NoPrice(uint16 feedId, uint64 round);
    error StalePrice(uint16 feedId, uint64 round, uint64 closeTime);

    /// @param operator_ Rollup creator's EVM address (same 20 bytes as its qor1 address).
    /// @param nativeChainId_ Native chain id, e.g. "qorechain-diana" (bound into anchors and signed messages).
    /// @param rollupId_ Rollup id, which is also its layer id (at most 31 bytes).
    /// @param twoSigMode_ True if anchors carry no round hash (see docs/SPEC.md, two-signature fallback).
    /// @param challengeWindow_ Seconds a round stays Pending (demo: 120).
    /// @param exitDelay_ Seconds from an exit request to withdrawal; at least two windows, so a round a scout took
    ///        part in can still be judged and slashed before its bond leaves.
    /// @param minOperatorBond_ Bond the operator must hold to post rounds.
    constructor(
        address operator_,
        string memory nativeChainId_,
        string memory rollupId_,
        bool twoSigMode_,
        uint64 challengeWindow_,
        uint64 exitDelay_,
        uint128 minOperatorBond_
    ) {
        if (
            operator_ == address(0) || challengeWindow_ == 0 || exitDelay_ < 2 * uint256(challengeWindow_)
                || minOperatorBond_ == 0 || bytes(nativeChainId_).length == 0 || bytes(rollupId_).length == 0
        ) revert BadConfig();
        operator = operator_;
        twoSigMode = twoSigMode_;
        challengeWindow = challengeWindow_;
        exitDelay = exitDelay_;
        minOperatorBond = minOperatorBond_;
        _nativeChainId = Text.pack(nativeChainId_);
        _rollupId = Text.pack(rollupId_);
    }

    // ---------------------------------------------------------------- rounds

    /// @notice Accept a round signed by the rollup creator. Anyone may relay it.
    /// @param att The round, as derived from the inbox.
    /// @param stateRoot The ledger root of the batch that anchors the round.
    /// @param txCount The batch's transaction count.
    /// @param anchorSig The creator's ML-DSA-87 anchor signature (in two-signature mode: anchor sig ‖ round sig).
    function postRound(RoundAttestation calldata att, bytes32 stateRoot, uint64 txCount, bytes calldata anchorSig)
        external
    {
        _checkAttestation(att);
        Bond storage ob = bonds[operator];
        // An exiting operator stops posting, so its last round is final before its bond can leave.
        if (ob.amount < minOperatorBond || ob.exitAt != 0) revert OperatorNotBonded();

        bytes32 rh = roundHash(att);
        (bool hasKey, bytes memory pubkey) = Pqc.keyOf(operator);
        if (!hasKey) revert NoPqKey(operator);
        if (!_verifyRound(pubkey, att, rh, stateRoot, txCount, anchorSig)) revert BadSignature();

        cursor = Cursor({lastRound: att.round, lastBatchIndex: att.batchIndex, started: true});
        rounds[att.round] = Round({
            reportsRoot: att.reportsRoot,
            postedAt: uint64(block.timestamp),
            closeTime: att.closeTime,
            batchIndex: att.batchIndex,
            reportCount: att.reportCount,
            corrected: false
        });
        _roundFeeds[att.round] = att.feedIds;
        for (uint256 i = 0; i < att.feedIds.length; i++) {
            uint16 f = att.feedIds[i];
            points[att.round][f] = FeedPoint({price: att.medians[i], count: att.counts[i], listed: true});
            FeedHead storage h = heads[f];
            h.prev = h.latest;
            h.latest = att.round;
        }
        emit RoundPosted(att.round, rh, stateRoot, txCount, att, anchorSig);
    }

    /// @notice Prove that a pending round's median is wrong. Recomputes every listed feed from the full set of leaves
    ///         under reportsRoot. On a mismatch: stores the right prices, marks the round Corrected, and slashes the
    ///         whole operator bond (half to the caller, half burned). An honest round reverts and nothing changes.
    /// @param round The pending round.
    /// @param leaves Every leaf of the round, sorted by scout address.
    function challengeMedian(uint64 round, Leaf[] calldata leaves) external {
        if (status(round) != Status.Pending) revert NotPending(round);
        Round storage r = rounds[round];

        bytes32[] memory hashes = new bytes32[](leaves.length);
        bool fault = leaves.length != r.reportCount;
        for (uint256 i = 0; i < leaves.length; i++) {
            if (i > 0 && leaves[i].scout <= leaves[i - 1].scout) revert LeavesNotSorted();
            hashes[i] = RoundCodec.leafHash(leaves[i]);
            // A committed leaf that is not a valid report for this round is the operator's fault too.
            if (leaves[i].round != round || leaves[i].feedIds.length != leaves[i].prices.length) fault = true;
        }
        if (RoundCodec.merkleRoot(hashes) != r.reportsRoot) revert RootMismatch();

        uint16[] memory feeds = _roundFeeds[round];
        uint128[] memory medians = new uint128[](feeds.length);
        uint8[] memory counts = new uint8[](feeds.length);
        for (uint256 k = 0; k < feeds.length; k++) {
            (uint128 m, uint256 n) = RoundCodec.medianOf(leaves, round, feeds[k]);
            if (n < QUORUM) m = 0; // no quorum: no price
            medians[k] = m;
            counts[k] = n > type(uint8).max ? type(uint8).max : uint8(n);
            FeedPoint storage p = points[round][feeds[k]];
            if (p.price != m || p.count != n) fault = true;
        }
        if (!fault) revert HonestRound(round);

        for (uint256 k = 0; k < feeds.length; k++) {
            FeedPoint storage p = points[round][feeds[k]];
            p.price = medians[k];
            p.count = counts[k];
        }
        r.corrected = true;
        emit MedianCorrected(round, msg.sender, feeds, medians, counts);
        _slash(operator, msg.sender);
    }

    /// @notice Slash a scout whose report in a settled round was more than SLASH_BPS from the median.
    /// @dev Needs the scout's own ML-DSA-87 COMMIT signature over its report, so a leaf the operator forged can
    ///      never cost an honest scout its bond (LIMITS.md L5).
    /// @param round A Final or Corrected round.
    /// @param leaf The scout's leaf.
    /// @param proof Merkle proof of the leaf under the round's reportsRoot.
    /// @param scoutSig The scout's COMMIT signature (keccak256 must equal leaf.commitSigHash).
    function slashOutlier(uint64 round, Leaf calldata leaf, bytes32[] calldata proof, bytes calldata scoutSig)
        external
    {
        Status s = status(round);
        if (s != Status.Final && s != Status.Corrected) revert NotFinal(round);
        if (leaf.round != round) revert NotInRound();
        if (!RoundCodec.verifyProof(proof, rounds[round].reportsRoot, RoundCodec.leafHash(leaf))) revert NotInRound();
        if (keccak256(scoutSig) != leaf.commitSigHash) revert SigNotCommitted();
        if (outlierSlashed[round][leaf.scout]) revert AlreadySlashed();
        if (!_isOutlier(round, leaf)) revert NotOutlier();

        (bool hasKey, bytes memory pubkey) = Pqc.keyOf(leaf.scout);
        if (!hasKey) revert NoPqKey(leaf.scout);
        if (!Pqc.verify(pubkey, scoutSig, commitMessage(leaf))) revert BadSignature();

        outlierSlashed[round][leaf.scout] = true;
        emit ScoutSlashed(round, leaf.scout, msg.sender, scoutSig);
        _slash(leaf.scout, msg.sender);
    }

    // ---------------------------------------------------------------- bonds

    /// @notice Add to the operator's bond. Anyone may pay.
    function bondOperator() external payable {
        _bond(operator);
    }

    /// @notice Add to any account's bond (a scout's, or the operator's). Anyone may pay.
    function bondFor(address who) external payable {
        _bond(who);
    }

    /// @notice Start the exit of `who`'s bond. Authorised only by `who`'s ML-DSA-87 signature over
    ///         "sealed-scouts/exit/v1|<evm chain id>|<this>|<who>|<nonce>" (QoreSign v1 message). Anyone may relay it.
    function requestExit(address who, bytes calldata pqSig) external {
        Bond storage b = bonds[who];
        if (b.amount == 0) revert NothingBonded();
        if (b.exitAt != 0) revert AlreadyExiting();
        _requireSigned(who, exitText(who, b.nonce), pqSig);
        b.nonce++;
        b.exitAt = uint64(block.timestamp) + exitDelay;
        emit ExitRequested(who, b.exitAt, pqSig);
    }

    /// @notice Pay out `who`'s bond to `to` once the exit delay has passed. Authorised only by `who`'s ML-DSA-87
    ///         signature over "sealed-scouts/withdraw/v1|<evm chain id>|<this>|<who>|<to>|<nonce>".
    function withdrawBond(address who, address to, bytes calldata pqSig) external {
        Bond storage b = bonds[who];
        if (b.exitAt == 0 || block.timestamp < b.exitAt) revert ExitNotReady();
        if (to == address(0)) revert BadConfig();
        _requireSigned(who, withdrawText(who, to, b.nonce), pqSig);
        uint256 amount = b.amount;
        b.nonce++;
        b.amount = 0;
        b.exitAt = 0;
        totalBonded -= amount;
        emit BondWithdrawn(who, to, amount, pqSig);
        _pay(to, amount);
    }

    // ---------------------------------------------------------------- reads

    /// @notice The newest round for a feed, whatever its status (0 none, 1 pending, 2 final, 3 corrected).
    /// @return price 8 decimals; 0 if none. @return round @return time The round's close time. @return status_
    function latest(uint16 feedId) external view returns (uint128 price, uint64 round, uint64 time, uint8 status_) {
        round = heads[feedId].latest;
        FeedPoint memory p = points[round][feedId];
        if (!p.listed) return (0, 0, 0, 0);
        return (p.price, round, rounds[round].closeTime, uint8(status(round)));
    }

    /// @notice The newest settled price of a feed. Reverts if the price is still pending, missing, or older than
    ///         `maxAge` seconds (measured from the round's close time). Consumers should read only this.
    function readFinal(uint16 feedId, uint64 maxAge) external view returns (uint128 price, uint64 round) {
        FeedHead memory h = heads[feedId];
        if (_settled(h.latest, feedId)) round = h.latest;
        else if (_settled(h.prev, feedId)) round = h.prev;
        else revert NoFinalPrice(feedId);

        price = points[round][feedId].price;
        if (price == 0) revert NoPrice(feedId, round);
        uint64 closeTime = rounds[round].closeTime;
        if (block.timestamp > uint256(closeTime) + maxAge) revert StalePrice(feedId, round, closeTime);
    }

    /// @notice Check a round receipt without posting it: true if the creator's current key signed this round.
    function verifyReceipt(RoundAttestation calldata att, bytes32 stateRoot, uint64 txCount, bytes calldata anchorSig)
        external
        view
        returns (bool)
    {
        (bool hasKey, bytes memory pubkey) = Pqc.keyOf(operator);
        if (!hasKey) return false;
        return _verifyRound(pubkey, att, roundHash(att), stateRoot, txCount, anchorSig);
    }

    function status(uint64 round) public view returns (Status) {
        Round storage r = rounds[round];
        if (r.postedAt == 0) return Status.None;
        if (r.corrected) return Status.Corrected;
        if (block.timestamp < uint256(r.postedAt) + challengeWindow) return Status.Pending;
        return Status.Final;
    }

    function roundFeeds(uint64 round) external view returns (uint16[] memory) {
        return _roundFeeds[round];
    }

    function nativeChainId() public view returns (string memory) {
        return string(Text.unpack(_nativeChainId));
    }

    function rollupId() public view returns (string memory) {
        return string(Text.unpack(_rollupId));
    }

    function roundHash(RoundAttestation calldata att) public view returns (bytes32) {
        return RoundCodec.roundHash(block.chainid, Text.unpack(_rollupId), att);
    }

    /// @notice The bytes the creator's anchor signature covers (vsh = round hash, or empty in two-signature mode).
    function anchorBytes(RoundAttestation calldata att, bytes32 stateRoot, uint64 txCount)
        public
        view
        returns (bytes memory)
    {
        bytes memory vsh = twoSigMode ? bytes("") : abi.encodePacked(roundHash(att));
        return _anchorMessage(att.batchIndex, stateRoot, vsh, txCount);
    }

    /// @notice Bytes of the operator's separate round signature (two-signature mode only).
    function roundSigMessage(uint64 round, bytes32 rh) public view returns (bytes memory) {
        return _signed(
            abi.encodePacked(
                "sealed-scouts/round/v1|", Text.unpack(_rollupId), "|", Text.decimal(round), "|", Text.hex32(rh)
            )
        );
    }

    /// @notice Bytes of a scout's COMMIT signature for this leaf (docs/SPEC.md, COMMIT signature text).
    function commitMessage(Leaf calldata leaf) public view returns (bytes memory) {
        return _signed(
            abi.encodePacked(
                "sealed-scouts/commit/v1|",
                Text.unpack(_rollupId),
                "|",
                Text.decimal(leaf.round),
                "|",
                Text.bech32Qor(leaf.scout),
                "|",
                Text.hex32(RoundCodec.commitment(leaf))
            )
        );
    }

    function exitText(address who, uint64 nonce) public view returns (bytes memory) {
        return abi.encodePacked(
            "sealed-scouts/exit/v1|",
            Text.decimal(block.chainid),
            "|",
            Text.hexAddress(address(this)),
            "|",
            Text.hexAddress(who),
            "|",
            Text.decimal(nonce)
        );
    }

    function withdrawText(address who, address to, uint64 nonce) public view returns (bytes memory) {
        return abi.encodePacked(
            "sealed-scouts/withdraw/v1|",
            Text.decimal(block.chainid),
            "|",
            Text.hexAddress(address(this)),
            "|",
            Text.hexAddress(who),
            "|",
            Text.hexAddress(to),
            "|",
            Text.decimal(nonce)
        );
    }

    // ---------------------------------------------------------------- internals

    function _checkAttestation(RoundAttestation calldata att) private view {
        uint256 n = att.feedIds.length;
        if (n == 0 || att.medians.length != n || att.counts.length != n) revert BadAttestation();
        if (att.inboxStart > att.inboxEnd || att.closeTime > block.timestamp) revert BadAttestation();
        for (uint256 i = 0; i < n; i++) {
            if (i > 0 && att.feedIds[i] <= att.feedIds[i - 1]) revert BadAttestation();
            if (att.counts[i] < QUORUM || att.medians[i] == 0) revert BadAttestation();
        }
        // Rounds and batches only move forward: an old or replayed anchor can never be posted again.
        Cursor memory c = cursor;
        if (c.started && (att.round <= c.lastRound || att.batchIndex <= c.lastBatchIndex)) revert StaleRound();
    }

    function _verifyRound(
        bytes memory pubkey,
        RoundAttestation calldata att,
        bytes32 rh,
        bytes32 stateRoot,
        uint64 txCount,
        bytes calldata sigs
    ) private view returns (bool) {
        if (!twoSigMode) {
            return Pqc.verify(pubkey, sigs, _anchorMessage(att.batchIndex, stateRoot, abi.encodePacked(rh), txCount));
        }
        if (sigs.length != 2 * Pqc.SIG_BYTES) return false;
        return Pqc.verify(pubkey, sigs[:Pqc.SIG_BYTES], _anchorMessage(att.batchIndex, stateRoot, "", txCount))
            && Pqc.verify(pubkey, sigs[Pqc.SIG_BYTES:], roundSigMessage(att.round, rh));
    }

    function _anchorMessage(uint64 batchIndex, bytes32 stateRoot, bytes memory vsh, uint64 txCount)
        private
        view
        returns (bytes memory)
    {
        return RoundCodec.anchorBytes(
            Text.unpack(_nativeChainId), Text.unpack(_rollupId), batchIndex, stateRoot, vsh, txCount
        );
    }

    function _isOutlier(uint64 round, Leaf calldata leaf) private view returns (bool) {
        uint256 n = leaf.feedIds.length < leaf.prices.length ? leaf.feedIds.length : leaf.prices.length;
        for (uint256 j = 0; j < n; j++) {
            FeedPoint memory p = points[round][leaf.feedIds[j]];
            if (!p.listed || p.price == 0) continue;
            if (RoundCodec.beyond(leaf.prices[j], p.price, SLASH_BPS)) return true;
        }
        return false;
    }

    function _settled(uint64 round, uint16 feedId) private view returns (bool) {
        if (!points[round][feedId].listed) return false;
        Status s = status(round);
        return s == Status.Final || s == Status.Corrected;
    }

    function _requireSigned(address who, bytes memory text, bytes calldata pqSig) private view {
        (bool hasKey, bytes memory pubkey) = Pqc.keyOf(who);
        if (!hasKey) revert NoPqKey(who);
        if (!Pqc.verify(pubkey, pqSig, _signed(text))) revert BadSignature();
    }

    function _signed(bytes memory text) private view returns (bytes memory) {
        return Pqc.messageBytes(Text.unpack(_nativeChainId), text);
    }

    function _bond(address who) private {
        if (msg.value == 0 || who == address(0) || msg.value > type(uint128).max) revert ZeroValue();
        Bond storage b = bonds[who];
        b.amount += uint128(msg.value);
        totalBonded += msg.value;
        emit Bonded(who, msg.sender, msg.value, b.amount);
    }

    /// @dev Takes the whole bond: half to `to`, the rest stays locked here as burned. Effects before the payment.
    function _slash(address who, address to) private {
        Bond storage b = bonds[who];
        uint256 amount = b.amount;
        uint256 reward = amount / 2;
        b.amount = 0;
        totalBonded -= amount;
        totalBurned += amount - reward;
        emit Slashed(who, to, reward, amount - reward);
        _pay(to, reward);
    }

    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert PayFailed();
    }
}
