// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// The slice of ERC-4337 v0.8 Mempire uses. The EntryPoint itself is the
/// canonical deployment at 0x4337084d9e255fF0702461CF8895cE9E3b5Ff108.
struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits; // verificationGasLimit (16 bytes) ‖ callGasLimit (16 bytes)
    uint256 preVerificationGas;
    bytes32 gasFees; // maxPriorityFeePerGas (16 bytes) ‖ maxFeePerGas (16 bytes)
    bytes paymasterAndData;
    bytes signature;
}

interface IEntryPointV08 {
    function handleOps(PackedUserOperation[] calldata ops, address payable beneficiary) external;
    function getUserOpHash(PackedUserOperation calldata userOp) external view returns (bytes32);
    function getNonce(address sender, uint192 key) external view returns (uint256);
    function depositTo(address account) external payable;
    function balanceOf(address account) external view returns (uint256);
}

interface IAccount {
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds)
        external
        returns (uint256 validationData);
}

interface IPaymaster {
    function validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 maxCost)
        external
        returns (bytes memory context, uint256 validationData);

    function postOp(uint8 mode, bytes calldata context, uint256 actualGasCost, uint256 actualUserOpFeePerGas)
        external;
}
