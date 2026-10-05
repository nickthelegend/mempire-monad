// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IReceiver} from "./interfaces/IReceiver.sol";

/// @title The market is the meta.
/// @notice Each epoch, a Chainlink CRE workflow reads the roster's 24-hour
/// price moves from independent sources, reaches consensus across the DON, and
/// writes one bounded modifier per fighter here. An asset that ran today fights
/// a little stronger today; one that dumped fights a little weaker.
///
/// The swing is capped at ±15% of stats, never touches elixir cost, and is
/// smaller than what levels give — so the market reshuffles the meta without
/// becoming a way to buy wins. Arena matches snapshot the epoch at join, so
/// both clients simulate the same numbers for the whole match.
contract MarketMeta is IReceiver, Ownable2Step {
    /// ±15%, in basis points.
    int16 public constant MAX_BPS = 1500;

    /// The KeystoneForwarder allowed to deliver reports. On testnet this is the
    /// simulation forwarder while `cre workflow simulate --broadcast` drives it.
    address public forwarder;
    /// When set, reports must come from a workflow owned by this address.
    address public expectedWorkflowOwner;

    uint64 public currentEpoch;
    mapping(uint64 epoch => uint64) public epochTimestamp;
    mapping(uint64 epoch => mapping(uint16 coinId => int16)) public modifierBps;

    event ForwarderChanged(address forwarder);
    event WorkflowOwnerChanged(address owner);
    event MetaPosted(uint64 indexed epoch, uint16[] coinIds, int16[] bps);

    error NotForwarder();
    error WrongWorkflowOwner();
    error StaleEpoch();
    error LengthMismatch();
    error OutOfBounds();

    constructor(address owner_, address forwarder_) Ownable(owner_) {
        forwarder = forwarder_;
        emit ForwarderChanged(forwarder_);
    }

    function setForwarder(address forwarder_) external onlyOwner {
        forwarder = forwarder_;
        emit ForwarderChanged(forwarder_);
    }

    function setExpectedWorkflowOwner(address owner_) external onlyOwner {
        expectedWorkflowOwner = owner_;
        emit WorkflowOwnerChanged(owner_);
    }

    /// @inheritdoc IReceiver
    /// @dev report = abi.encode(uint64 epoch, uint16[] coinIds, int16[] bps).
    /// Stale or replayed epochs are rejected rather than ignored, so a
    /// forwarder retry of an old report is visible.
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != forwarder) revert NotForwarder();
        if (expectedWorkflowOwner != address(0)) {
            if (_workflowOwner(metadata) != expectedWorkflowOwner) revert WrongWorkflowOwner();
        }
        (uint64 epoch, uint16[] memory coinIds, int16[] memory bps) =
            abi.decode(report, (uint64, uint16[], int16[]));
        if (epoch <= currentEpoch) revert StaleEpoch();
        if (coinIds.length != bps.length) revert LengthMismatch();
        for (uint256 i; i < coinIds.length; ++i) {
            if (bps[i] > MAX_BPS || bps[i] < -MAX_BPS) revert OutOfBounds();
            modifierBps[epoch][coinIds[i]] = bps[i];
        }
        currentEpoch = epoch;
        epochTimestamp[epoch] = uint64(block.timestamp);
        emit MetaPosted(epoch, coinIds, bps);
    }

    /// The modifiers a match will use, in the order asked.
    function modifiersFor(uint64 epoch, uint16[] calldata coinIds) external view returns (int16[] memory out) {
        out = new int16[](coinIds.length);
        for (uint256 i; i < coinIds.length; ++i) {
            out[i] = modifierBps[epoch][coinIds[i]];
        }
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    /// CRE metadata is abi.encodePacked(bytes32 workflowId, bytes10 workflowName,
    /// address workflowOwner): the owner sits at bytes [42, 62).
    function _workflowOwner(bytes calldata metadata) internal pure returns (address owner) {
        if (metadata.length < 62) return address(0);
        owner = address(bytes20(metadata[42:62]));
    }
}
