// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {PasskeyRegistry} from "../src/PasskeyRegistry.sol";

/// Real P256 signatures (forge's `signP256`) over real WebAuthn-shaped
/// assertions, verified through the P256VERIFY precompile at `0x0100`.
/// Runs under the `osaka` profile, the EVM that has the precompile — as Monad
/// does:  FOUNDRY_PROFILE=osaka forge test --match-contract PasskeyRegistry
contract PasskeyRegistryTest is Test {
    PasskeyRegistry reg;
    uint256 constant PK = 0x1d2a3b4c5d6e7f80112233445566778899aabbccddeeff00112233445566778;
    address alice = address(0xA11CE);
    bytes32 x;
    bytes32 y;
    // rpIdHash ‖ flags (UP|UV) ‖ signCount
    bytes authData = abi.encodePacked(sha256("mempire.fun"), uint8(0x05), uint32(1));

    function setUp() public {
        reg = new PasskeyRegistry();
        (uint256 px, uint256 py) = vm.publicKeyP256(PK);
        x = bytes32(px);
        y = bytes32(py);
        // Only an EVM with P256VERIFY at 0x0100 can run these (Monad, Osaka).
        // Precompiles have no code, so ask it to verify a real signature.
        bytes32 h = keccak256("probe");
        (bytes32 r, bytes32 s) = vm.signP256(PK, h);
        (bool ok, bytes memory out) = address(0x100).staticcall(abi.encode(h, r, s, x, y));
        if (!ok || out.length != 32) vm.skip(true);
    }

    function _client(bytes32 challenge, string memory kind) internal pure returns (string memory) {
        return string.concat(
            '{"type":"', kind, '","challenge":"', Base64.encodeURL(abi.encodePacked(challenge)),
            '","origin":"https://mempire.fun","crossOrigin":false}'
        );
    }

    function _sign(bytes memory ad, string memory json) internal pure returns (bytes32 r, bytes32 s) {
        bytes32 h = sha256(abi.encodePacked(ad, sha256(bytes(json))));
        return vm.signP256(PK, h);
    }

    function test_bindWithAValidAssertion() public {
        string memory json = _client(reg.challengeFor(alice), "webauthn.get");
        (bytes32 r, bytes32 s) = _sign(authData, json);
        vm.prank(alice);
        reg.bind(x, y, authData, json, r, s);
        (bytes32 bx, bytes32 by) = reg.passkeyOf(alice);
        assertEq(bx, x);
        assertEq(by, y);
        assertEq(reg.nonces(alice), 1);
    }

    function test_anAssertionCannotBeReplayed() public {
        string memory json = _client(reg.challengeFor(alice), "webauthn.get");
        (bytes32 r, bytes32 s) = _sign(authData, json);
        vm.prank(alice);
        reg.bind(x, y, authData, json, r, s);
        vm.prank(alice);
        vm.expectRevert(PasskeyRegistry.WrongChallenge.selector);
        reg.bind(x, y, authData, json, r, s);
    }

    function test_anotherAccountsChallengeIsRefused() public {
        string memory json = _client(reg.challengeFor(address(0xB0B)), "webauthn.get");
        (bytes32 r, bytes32 s) = _sign(authData, json);
        vm.prank(alice);
        vm.expectRevert(PasskeyRegistry.WrongChallenge.selector);
        reg.bind(x, y, authData, json, r, s);
    }

    function test_aTamperedSignatureIsRefused() public {
        string memory json = _client(reg.challengeFor(alice), "webauthn.get");
        (bytes32 r, bytes32 s) = _sign(authData, json);
        vm.prank(alice);
        vm.expectRevert(PasskeyRegistry.BadSignature.selector);
        reg.bind(x, y, authData, json, r, bytes32(uint256(s) ^ 1));
    }

    function test_theWrongKeyIsRefused() public {
        string memory json = _client(reg.challengeFor(alice), "webauthn.get");
        (bytes32 r, bytes32 s) = _sign(authData, json);
        (uint256 ox, uint256 oy) = vm.publicKeyP256(PK + 1);
        vm.prank(alice);
        vm.expectRevert(PasskeyRegistry.BadSignature.selector);
        reg.bind(bytes32(ox), bytes32(oy), authData, json, r, s);
    }

    function test_aRegistrationCeremonyIsNotAnAssertion() public {
        string memory json = _client(reg.challengeFor(alice), "webauthn.create");
        (bytes32 r, bytes32 s) = _sign(authData, json);
        vm.prank(alice);
        vm.expectRevert(PasskeyRegistry.WrongCeremony.selector);
        reg.bind(x, y, authData, json, r, s);
    }

    function test_userPresenceIsRequired() public {
        bytes memory noUp = abi.encodePacked(sha256("mempire.fun"), uint8(0x04), uint32(1));
        string memory json = _client(reg.challengeFor(alice), "webauthn.get");
        (bytes32 r, bytes32 s) = _sign(noUp, json);
        vm.prank(alice);
        vm.expectRevert(PasskeyRegistry.NotUserPresent.selector);
        reg.bind(x, y, noUp, json, r, s);
    }

    function test_verifySessionWithTheBoundPasskey() public {
        string memory json = _client(reg.challengeFor(alice), "webauthn.get");
        (bytes32 r, bytes32 s) = _sign(authData, json);
        vm.prank(alice);
        reg.bind(x, y, authData, json, r, s);

        bytes32 stepUp = keccak256("stake 100 AUSD on match 7");
        string memory json2 = _client(stepUp, "webauthn.get");
        (bytes32 r2, bytes32 s2) = _sign(authData, json2);
        assertTrue(reg.verifySession(alice, stepUp, authData, json2, r2, s2));
        assertFalse(reg.verifySession(alice, stepUp, authData, json2, r2, bytes32(uint256(s2) ^ 1)));
        vm.expectRevert(PasskeyRegistry.NoPasskey.selector);
        reg.verifySession(address(0xB0B), stepUp, authData, json2, r2, s2);
    }

    function test_precompileGasIsSmall() public {
        string memory json = _client(reg.challengeFor(alice), "webauthn.get");
        (bytes32 r, bytes32 s) = _sign(authData, json);
        vm.prank(alice);
        uint256 g = gasleft();
        reg.bind(x, y, authData, json, r, s);
        // Whole bind (JSON scan + two sha256 + storage) stays far below a Solidity P256 verify (~200k+).
        assertLt(g - gasleft(), 150_000);
    }
}
