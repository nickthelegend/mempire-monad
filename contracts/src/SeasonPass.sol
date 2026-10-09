// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MempireCards} from "./MempireCards.sol";

interface IArenaWins {
    function wins(address player) external view returns (uint32);
}

/// A season pass, bought with $MEMPIRE.
///
/// What it is: during a season, a pass holder unlocks reward tiers by winning
/// staked matches; each tier claims one golden chest (real ERC-721 cards). The
/// price is paid to the treasury — spent, not staked, not locked, not
/// refundable — and the pass is not transferable. It promises nothing about
/// the value of $MEMPIRE or of anything else; it is a game mechanic.
///
/// Progress comes from the arena itself: `MempireArena.wins` (staked wins both
/// seats agreed on; walkovers excluded) at claim time, minus its value when the
/// pass was bought. Claims close when the season ends, so only wins inside the
/// season can count. No relay, no signature, no off-chain score.
contract SeasonPass is Ownable {
    using SafeERC20 for IERC20;

    struct Season {
        uint64 startsAt;
        uint64 endsAt;
        uint128 price;
    }

    IERC20 public immutable mempire;
    IArenaWins public immutable arena;
    MempireCards public immutable cards;
    address public treasury;

    uint256 public seasonCount;
    mapping(uint256 seasonId => Season) public seasons;
    mapping(uint256 seasonId => uint16[]) internal _tierWins;
    /// Arena wins at purchase, plus one (0 = no pass).
    mapping(uint256 seasonId => mapping(address player => uint32)) public passBase;
    mapping(uint256 seasonId => mapping(address player => uint256)) public claimedMask;

    event SeasonStarted(uint256 indexed seasonId, uint64 startsAt, uint64 endsAt, uint128 price, uint16[] tierWins);
    event PassBought(uint256 indexed seasonId, address indexed player, uint128 price);
    event TierClaimed(uint256 indexed seasonId, address indexed player, uint8 tier, uint256 chestId);

    error BadSeason();
    error SeasonNotOpen();
    error AlreadyHasPass();
    error NoPass();
    error NoSuchTier();
    error TierLocked();
    error AlreadyClaimed();

    constructor(address owner_, IERC20 mempire_, IArenaWins arena_, MempireCards cards_, address treasury_) Ownable(owner_) {
        mempire = mempire_;
        arena = arena_;
        cards = cards_;
        treasury = treasury_;
    }

    function setTreasury(address treasury_) external onlyOwner {
        treasury = treasury_;
    }

    /// Open a season: wins needed per tier, strictly increasing, at most 8 tiers.
    function startSeason(uint64 startsAt, uint64 endsAt, uint128 price, uint16[] calldata tierWins)
        external
        onlyOwner
        returns (uint256 id)
    {
        if (endsAt <= startsAt || tierWins.length == 0 || tierWins.length > 8) revert BadSeason();
        for (uint256 i; i < tierWins.length; ++i) {
            if (tierWins[i] == 0 || (i > 0 && tierWins[i] <= tierWins[i - 1])) revert BadSeason();
        }
        id = ++seasonCount;
        seasons[id] = Season(startsAt, endsAt, price);
        _tierWins[id] = tierWins;
        emit SeasonStarted(id, startsAt, endsAt, price, tierWins);
    }

    function tierWins(uint256 id) external view returns (uint16[] memory) {
        return _tierWins[id];
    }

    function _open(uint256 id) internal view returns (Season memory s) {
        s = seasons[id];
        if (s.endsAt == 0 || block.timestamp < s.startsAt || block.timestamp >= s.endsAt) revert SeasonNotOpen();
    }

    function buyPass(uint256 id) external {
        Season memory s = _open(id);
        if (passBase[id][msg.sender] != 0) revert AlreadyHasPass();
        passBase[id][msg.sender] = arena.wins(msg.sender) + 1;
        mempire.safeTransferFrom(msg.sender, treasury, s.price);
        emit PassBought(id, msg.sender, s.price);
    }

    /// Staked wins since the pass was bought (0 without a pass).
    function progress(uint256 id, address player) public view returns (uint32) {
        uint32 base = passBase[id][player];
        return base == 0 ? 0 : arena.wins(player) - (base - 1);
    }

    function claim(uint256 id, uint8 tier) external returns (uint256 chestId) {
        _open(id);
        if (passBase[id][msg.sender] == 0) revert NoPass();
        uint16[] storage t = _tierWins[id];
        if (tier >= t.length) revert NoSuchTier();
        if (progress(id, msg.sender) < t[tier]) revert TierLocked();
        uint256 bit = uint256(1) << tier;
        if (claimedMask[id][msg.sender] & bit != 0) revert AlreadyClaimed();
        claimedMask[id][msg.sender] |= bit;
        chestId = cards.grantGolden(msg.sender);
        emit TierClaimed(id, msg.sender, tier, chestId);
    }
}
