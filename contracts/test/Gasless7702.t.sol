// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {Vm} from "forge-std/Vm.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IEntryPointV08, PackedUserOperation} from "../src/aa/IEntryPointV08.sol";
import {MempireAccount7702} from "../src/MempireAccount7702.sol";
import {MempirePaymaster} from "../src/MempirePaymaster.sol";
import {MempireCards} from "../src/MempireCards.sol";

/// Gasless chests: a player with zero MON delegates their own address to
/// MempireAccount7702 (EIP-7702) and opens a chest through the canonical
/// ERC-4337 v0.8 EntryPoint, with MempirePaymaster paying the gas.
///
/// The EntryPoint is not a re-implementation: its runtime bytecode is read from
/// Monad testnet (test/fixtures/EntryPointV08.runtime.hex) and placed at its
/// canonical address.
///
/// EIP-7702 needs Prague, so this runs under the osaka profile:
///   FOUNDRY_PROFILE=osaka forge test --match-contract Gasless7702
contract Gasless7702Test is Base {
    IEntryPointV08 constant EP = IEntryPointV08(0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108);
    MempireAccount7702 impl;
    MempirePaymaster paymaster;
    address sponsor;
    uint256 sponsorKey;
    address player;
    uint256 playerKey;
    address bundler = makeAddr("bundler");
    uint256 chestId;

    function setUp() public override {
        if (keccak256(bytes(vm.envOr("FOUNDRY_PROFILE", string("default")))) != keccak256("osaka")) vm.skip(true);
        super.setUp();
        vm.etch(address(EP), vm.parseBytes(vm.trim(vm.readFile("test/fixtures/EntryPointV08.runtime.hex"))));
        (sponsor, sponsorKey) = makeAddrAndKey("sponsor");
        (player, playerKey) = makeAddrAndKey("player");
        impl = new MempireAccount7702();
        paymaster = new MempirePaymaster(admin, EP, address(cards), sponsor);
        vm.deal(admin, 1 ether);
        vm.prank(admin);
        paymaster.deposit{value: 1 ether}();

        // A golden chest, ready to open. Bought by a prank, which costs no gas.
        vm.prank(alice);
        token.transfer(player, 1_000 ether);
        vm.startPrank(player);
        token.approve(address(cards), type(uint256).max);
        chestId = cards.buyChest();
        vm.stopPrank();

        vm.signAndAttachDelegation(address(impl), playerKey);
        assertEq(player.balance, 0, "the player holds no MON");
    }

    function chestState(uint256 id) internal view returns (uint8 state) {
        (,, state,,) = cards.chests(id);
    }

    function op(bytes memory inner, uint48 validUntil) internal view returns (PackedUserOperation memory u) {
        u.sender = player;
        u.nonce = EP.getNonce(player, 0);
        u.callData = abi.encodeCall(MempireAccount7702.execute, (address(cards), 0, inner));
        u.accountGasLimits = bytes32((uint256(150_000) << 128) | 1_500_000);
        u.preVerificationGas = 50_000;
        u.gasFees = bytes32((uint256(1 gwei) << 128) | 2 gwei);
        u.paymasterAndData = abi.encodePacked(address(paymaster), uint128(100_000), uint128(30_000), validUntil, uint48(0), new bytes(65));
    }

    function sponsorSign(PackedUserOperation memory u, uint256 key) internal view {
        uint48 until = uint48(bytes6(slice(u.paymasterAndData, 52, 6)));
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(paymaster.sponsorHash(u, until, 0));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        u.paymasterAndData = abi.encodePacked(slice(u.paymasterAndData, 0, 64), r, s, v);
    }

    function playerSign(PackedUserOperation memory u, uint256 key) internal view {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, EP.getUserOpHash(u));
        u.signature = abi.encodePacked(r, s, v);
    }

    function slice(bytes memory b, uint256 from, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i; i < len; i++) out[i] = b[from + i];
    }

    function bundle(PackedUserOperation memory u) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = u;
        vm.prank(bundler, bundler); // the EntryPoint requires an EOA bundler
        EP.handleOps(ops, payable(bundler));
    }

    /// Bundles and requires the inner call to have succeeded: a reverted inner
    /// call does not revert handleOps, it only shows in UserOperationEvent.
    function bundleOk(PackedUserOperation memory u) internal {
        vm.recordLogs();
        bundle(u);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(EP) && logs[i].topics[0] == topic) {
                (, bool success,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                assertTrue(success, "the sponsored call succeeded");
                return;
            }
        }
        fail();
    }

    function signed(bytes memory inner) internal view returns (PackedUserOperation memory u) {
        u = op(inner, uint48(block.timestamp + 5 minutes));
        sponsorSign(u, sponsorKey);
        playerSign(u, playerKey);
    }

    function test_aPlayerWithNoMonOpensAChestThePaymasterPays() public {
        uint256 depositBefore = EP.balanceOf(address(paymaster));
        bundleOk(signed(abi.encodeCall(MempireCards.open, (chestId))));
        assertEq(chestState(chestId), 3, "the chest is revealing");
        assertEq(player.balance, 0, "the player still holds no MON");
        assertLt(EP.balanceOf(address(paymaster)), depositBefore, "the paymaster paid");
        assertGt(bundler.balance, 0, "the bundler was reimbursed");

        // Then reveal it, also sponsored: the cards land on the player's own address.
        vm.roll(block.number + 2);
        (uint256[] memory before,,) = cards.cardsOf(player);
        bundleOk(signed(abi.encodeCall(MempireCards.reveal, (chestId, new uint16[](0)))));
        (uint256[] memory afterIds,,) = cards.cardsOf(player);
        assertGt(afterIds.length, before.length, "cards minted to the player");
    }

    function test_onlyTheChestLoopIsSponsored() public {
        PackedUserOperation memory u = signed(abi.encodeWithSignature("transferFrom(address,address,uint256)", player, alice, 1));
        vm.expectRevert();
        bundle(u);
        assertFalse(paymaster.sponsorable(abi.encodeCall(MempireAccount7702.execute, (address(token), 0, abi.encodeWithSignature("transfer(address,uint256)", alice, 1)))));
    }

    function test_aFieldChangedAfterTheSponsorSignedIsRefused() public {
        PackedUserOperation memory u = op(abi.encodeCall(MempireCards.open, (chestId)), uint48(block.timestamp + 5 minutes));
        sponsorSign(u, sponsorKey);
        u.gasFees = bytes32((uint256(50 gwei) << 128) | 100 gwei); // a pricier op than was approved
        playerSign(u, playerKey);
        vm.expectRevert();
        bundle(u);
        assertEq(chestState(chestId), 2, "nothing happened");
    }

    function test_anotherKeyCannotSpeakForThePlayer() public {
        PackedUserOperation memory u = op(abi.encodeCall(MempireCards.open, (chestId)), uint48(block.timestamp + 5 minutes));
        sponsorSign(u, sponsorKey);
        (, uint256 otherKey) = makeAddrAndKey("other");
        playerSign(u, otherKey);
        vm.expectRevert();
        bundle(u);
    }

    function test_anExpiredSponsorshipIsRefused() public {
        PackedUserOperation memory u = op(abi.encodeCall(MempireCards.open, (chestId)), uint48(block.timestamp + 60));
        sponsorSign(u, sponsorKey);
        playerSign(u, playerKey);
        vm.warp(block.timestamp + 61);
        vm.expectRevert();
        bundle(u);
    }

    function test_onlyTheEntryPointCanDriveTheAccount() public {
        vm.prank(alice);
        vm.expectRevert(MempireAccount7702.NotEntryPoint.selector);
        MempireAccount7702(payable(player)).execute(address(cards), 0, abi.encodeCall(MempireCards.open, (chestId)));
    }
}
