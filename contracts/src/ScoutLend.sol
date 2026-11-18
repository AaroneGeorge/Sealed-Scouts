// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice The one PriceFeed function a consumer needs.
interface IFinalPrice {
    function readFinal(uint16 feedId, uint64 maxAge) external view returns (uint128 price, uint64 round);
}

interface IERC20Min {
    function decimals() external view returns (uint8);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title ScoutLend
/// @notice A tiny demo lender: deposit fETH, borrow fUSD up to an LTV. Every price comes from
///         PriceFeed.readFinal, so a pending (still challengeable) or stale price stops borrowing, withdrawing and
///         liquidating instead of being trusted.
/// @dev Demo only: no interest, no lender shares. fUSD sent with supply() is pool liquidity and stays here.
contract ScoutLend {
    struct Position {
        uint256 collateral;
        uint256 debt;
    }

    IFinalPrice public immutable feed;
    IERC20Min public immutable collateralToken;
    IERC20Min public immutable debtToken;
    uint16 public immutable collateralFeedId;
    uint16 public immutable debtFeedId;
    uint16 public immutable ltvBps; // borrow limit
    uint16 public immutable liquidationBps; // above this a position can be liquidated
    uint64 public immutable maxPriceAge;
    uint256 private immutable _collateralUnit;
    uint256 private immutable _debtUnit;

    mapping(address => Position) public positions;

    event Supplied(address indexed from, uint256 amount);
    event Deposited(address indexed user, uint256 amount);
    event Borrowed(address indexed user, uint256 amount, uint64 collateralRound, uint64 debtRound);
    event Repaid(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event Liquidated(address indexed user, address indexed liquidator, uint256 debt, uint256 collateral);

    error BadConfig();
    error ZeroAmount();
    error Unhealthy();
    error Healthy();
    error TransferFailed();

    constructor(
        IFinalPrice feed_,
        IERC20Min collateralToken_,
        IERC20Min debtToken_,
        uint16 collateralFeedId_,
        uint16 debtFeedId_,
        uint16 ltvBps_,
        uint16 liquidationBps_,
        uint64 maxPriceAge_
    ) {
        if (ltvBps_ == 0 || ltvBps_ >= liquidationBps_ || liquidationBps_ > 10_000 || maxPriceAge_ == 0) {
            revert BadConfig();
        }
        feed = feed_;
        collateralToken = collateralToken_;
        debtToken = debtToken_;
        collateralFeedId = collateralFeedId_;
        debtFeedId = debtFeedId_;
        ltvBps = ltvBps_;
        liquidationBps = liquidationBps_;
        maxPriceAge = maxPriceAge_;
        _collateralUnit = 10 ** collateralToken_.decimals();
        _debtUnit = 10 ** debtToken_.decimals();
    }

    /// @notice Add fUSD liquidity for borrowers.
    function supply(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        emit Supplied(msg.sender, amount);
        _pull(debtToken, amount);
    }

    /// @notice Deposit fETH collateral.
    function deposit(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        positions[msg.sender].collateral += amount;
        emit Deposited(msg.sender, amount);
        _pull(collateralToken, amount);
    }

    /// @notice Borrow fUSD against your collateral. Reverts if a price is pending or stale.
    function borrow(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        Position storage p = positions[msg.sender];
        p.debt += amount;
        (bool ok, uint64 cRound, uint64 dRound) = _within(p, ltvBps);
        if (!ok) revert Unhealthy();
        emit Borrowed(msg.sender, amount, cRound, dRound);
        _push(debtToken, msg.sender, amount);
    }

    /// @notice Repay fUSD debt (needs no price).
    function repay(uint256 amount) external {
        Position storage p = positions[msg.sender];
        if (amount == 0 || amount > p.debt) revert ZeroAmount();
        p.debt -= amount;
        emit Repaid(msg.sender, amount);
        _pull(debtToken, amount);
    }

    /// @notice Take collateral back. With open debt the position must stay within the LTV at a final price.
    function withdraw(uint256 amount) external {
        Position storage p = positions[msg.sender];
        if (amount == 0 || amount > p.collateral) revert ZeroAmount();
        p.collateral -= amount;
        if (p.debt > 0) {
            (bool ok,,) = _within(p, ltvBps);
            if (!ok) revert Unhealthy();
        }
        emit Withdrawn(msg.sender, amount);
        _push(collateralToken, msg.sender, amount);
    }

    /// @notice Repay a position that is past the liquidation threshold and take all its collateral.
    function liquidate(address user) external {
        Position storage p = positions[user];
        (bool ok,,) = _within(p, liquidationBps);
        if (ok || p.debt == 0) revert Healthy();
        uint256 debt = p.debt;
        uint256 collateral = p.collateral;
        delete positions[user];
        emit Liquidated(user, msg.sender, debt, collateral);
        _pull(debtToken, debt);
        _push(collateralToken, msg.sender, collateral);
    }

    /// @notice Debt and collateral of a position in USD (8 decimals) at the latest final, fresh prices.
    function valueOf(address user) external view returns (uint256 collateralUsd, uint256 debtUsd) {
        (collateralUsd, debtUsd,,) = _values(positions[user]);
    }

    function _within(Position storage p, uint256 bps) private view returns (bool ok, uint64 cRound, uint64 dRound) {
        uint256 collateralUsd;
        uint256 debtUsd;
        (collateralUsd, debtUsd, cRound, dRound) = _values(p);
        ok = debtUsd * 10_000 <= collateralUsd * bps;
    }

    function _values(Position storage p)
        private
        view
        returns (uint256 collateralUsd, uint256 debtUsd, uint64 cRound, uint64 dRound)
    {
        uint128 cPrice;
        uint128 dPrice;
        (cPrice, cRound) = feed.readFinal(collateralFeedId, maxPriceAge);
        (dPrice, dRound) = feed.readFinal(debtFeedId, maxPriceAge);
        collateralUsd = p.collateral * cPrice / _collateralUnit;
        debtUsd = p.debt * dPrice / _debtUnit;
    }

    function _pull(IERC20Min token, uint256 amount) private {
        _call(address(token), abi.encodeCall(IERC20Min.transferFrom, (msg.sender, address(this), amount)));
    }

    function _push(IERC20Min token, address to, uint256 amount) private {
        _call(address(token), abi.encodeCall(IERC20Min.transfer, (to, amount)));
    }

    /// @dev Accepts tokens that return true or nothing; anything else is a failed transfer.
    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool))) || token.code.length == 0) revert TransferFailed();
    }
}
