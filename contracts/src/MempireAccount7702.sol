// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IAccount, PackedUserOperation} from "./aa/IEntryPointV08.sol";

/// @title MempireAccount7702
/// @notice The code a player's own address delegates to with EIP-7702, so the
/// address can send ERC-4337 user operations — and a paymaster can pay their gas.
///
/// The player keeps their address and key: a user operation is valid only if
/// that same key signed it. Only the canonical EntryPoint can run a call, or
/// the address itself. Nothing is stored, so delegating and later
/// un-delegating leaves no state behind.
contract MempireAccount7702 is IAccount {
    address public constant ENTRY_POINT = 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108;
    uint256 internal constant SIG_FAILED = 1;

    error NotEntryPoint();
    error CallFailed(bytes reason);

    modifier onlyEntryPointOrSelf() {
        if (msg.sender != ENTRY_POINT && msg.sender != address(this)) revert NotEntryPoint();
        _;
    }

    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds)
        external
        returns (uint256)
    {
        if (msg.sender != ENTRY_POINT) revert NotEntryPoint();
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(userOpHash, userOp.signature);
        // Pays only when no paymaster does; with Mempire's paymaster this is 0.
        if (missingAccountFunds > 0) {
            (bool ok,) = payable(msg.sender).call{value: missingAccountFunds}("");
            ok;
        }
        return err == ECDSA.RecoverError.NoError && signer == address(this) ? 0 : SIG_FAILED;
    }

    function execute(address target, uint256 value, bytes calldata data) external onlyEntryPointOrSelf {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) revert CallFailed(ret);
    }

    receive() external payable {}
}
