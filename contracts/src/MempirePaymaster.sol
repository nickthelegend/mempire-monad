// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IEntryPointV08, IPaymaster, PackedUserOperation} from "./aa/IEntryPointV08.sol";
import {MempireAccount7702} from "./MempireAccount7702.sol";
import {MempireCards} from "./MempireCards.sol";

/// @title MempirePaymaster
/// @notice Pays the gas for a new player's chest loop — start the timer, open,
/// reveal — so a player with no MON can still play it.
///
/// Two checks, both in validation, so the EntryPoint never charges this
/// deposit for anything else:
///  - the call is `MempireAccount7702.execute(cards, 0, …)` with one of the
///    three chest selectors, and nothing else;
///  - the relay's sponsor key signed this exact operation (sender, nonce,
///    calldata, gas limits and fees) for a short window, so it can rate-limit
///    who gets sponsored. A changed field voids the signature.
///
/// paymasterAndData = paymaster (20) ‖ verificationGasLimit (16) ‖ postOpGasLimit (16)
///                    ‖ validUntil (6) ‖ validAfter (6) ‖ signature (65)
contract MempirePaymaster is IPaymaster, Ownable {
    uint256 internal constant DATA_OFFSET = 52;
    uint256 internal constant SIG_OFFSET = DATA_OFFSET + 12;

    IEntryPointV08 public immutable entryPoint;
    address public immutable cards;
    address public sponsor;

    event SponsorSet(address sponsor);

    error NotEntryPoint();
    error NotSponsorable();
    error BadPaymasterData();

    constructor(address owner_, IEntryPointV08 entryPoint_, address cards_, address sponsor_) Ownable(owner_) {
        entryPoint = entryPoint_;
        cards = cards_;
        sponsor = sponsor_;
        emit SponsorSet(sponsor_);
    }

    function setSponsor(address sponsor_) external onlyOwner {
        sponsor = sponsor_;
        emit SponsorSet(sponsor_);
    }

    /// The deposit the EntryPoint draws gas from.
    function deposit() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }

    /// What the sponsor key signs (as an EIP-191 message).
    function sponsorHash(PackedUserOperation calldata op, uint48 validUntil, uint48 validAfter)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                op.sender,
                op.nonce,
                keccak256(op.initCode),
                keccak256(op.callData),
                op.accountGasLimits,
                bytes32(op.paymasterAndData[20:52]),
                op.preVerificationGas,
                op.gasFees,
                block.chainid,
                address(this),
                validUntil,
                validAfter
            )
        );
    }

    /// True for `execute(cards, 0, startUnlock|open|reveal(…))`.
    function sponsorable(bytes calldata callData) public view returns (bool) {
        if (callData.length < 4 || bytes4(callData[:4]) != MempireAccount7702.execute.selector) return false;
        (address target, uint256 value, bytes memory inner) = abi.decode(callData[4:], (address, uint256, bytes));
        if (target != cards || value != 0 || inner.length < 4) return false;
        bytes4 sel = bytes4(inner);
        return sel == MempireCards.startUnlock.selector || sel == MempireCards.open.selector
            || sel == MempireCards.reveal.selector;
    }

    function validatePaymasterUserOp(PackedUserOperation calldata op, bytes32, uint256)
        external
        view
        returns (bytes memory context, uint256 validationData)
    {
        if (msg.sender != address(entryPoint)) revert NotEntryPoint();
        if (op.paymasterAndData.length != SIG_OFFSET + 65) revert BadPaymasterData();
        if (!sponsorable(op.callData)) revert NotSponsorable();
        uint48 validUntil = uint48(bytes6(op.paymasterAndData[DATA_OFFSET:DATA_OFFSET + 6]));
        uint48 validAfter = uint48(bytes6(op.paymasterAndData[DATA_OFFSET + 6:SIG_OFFSET]));
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(sponsorHash(op, validUntil, validAfter));
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, op.paymasterAndData[SIG_OFFSET:]);
        uint256 failed = err == ECDSA.RecoverError.NoError && signer == sponsor ? 0 : 1;
        return ("", failed | (uint256(validUntil) << 160) | (uint256(validAfter) << 208));
    }

    function postOp(uint8, bytes calldata, uint256, uint256) external view {
        if (msg.sender != address(entryPoint)) revert NotEntryPoint();
    }

    /// Take back unused deposit.
    function withdraw(address payable to, uint256 amount) external onlyOwner {
        (bool ok,) = address(entryPoint).call(abi.encodeWithSignature("withdrawTo(address,uint256)", to, amount));
        require(ok, "withdraw failed");
    }
}
