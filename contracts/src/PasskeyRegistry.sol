// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

/// Passkeys on Monad, checked on chain.
///
/// Monad ships the P256VERIFY precompile at `0x0100` (EIP-7951, the RIP-7212
/// interface, ~6,900 gas), so a WebAuthn signature — what Face ID, Touch ID or a
/// security key produces — can be verified by a contract directly, with no
/// Solidity curve maths.
///
/// An account binds a passkey's public key by presenting a WebAuthn assertion
/// over its *current challenge*: `keccak256(chainid, this, account, nonce)`,
/// base64url-encoded inside `clientDataJSON` exactly as browsers put it. The
/// nonce moves on every bind, so an assertion can never be replayed. After
/// that, `verifySession` checks any passkey-signed challenge for the account —
/// a step-up for a big stake, a session handover — in one view call.
///
/// Uses `P256.verifyNative`: the precompile or nothing. On a chain without it
/// this reverts with `MissingPrecompile` instead of silently running the far
/// more expensive Solidity verifier.
contract PasskeyRegistry {
    struct Key {
        bytes32 x;
        bytes32 y;
    }

    mapping(address => Key) public passkeyOf;
    mapping(address => uint256) public nonces;

    event PasskeyBound(address indexed account, bytes32 x, bytes32 y);

    error NotUserPresent();
    error WrongCeremony();
    error WrongChallenge();
    error BadSignature();
    error NoPasskey();

    /// The challenge the next `bind` from `account` must sign.
    function challengeFor(address account) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), account, nonces[account]));
    }

    /// Bind `(x, y)` to the caller with an assertion over `challengeFor(msg.sender)`.
    function bind(
        bytes32 x,
        bytes32 y,
        bytes calldata authenticatorData,
        string calldata clientDataJSON,
        bytes32 r,
        bytes32 s
    ) external {
        if (!_assertion(challengeFor(msg.sender), x, y, authenticatorData, clientDataJSON, r, s)) revert BadSignature();
        nonces[msg.sender] += 1;
        passkeyOf[msg.sender] = Key(x, y);
        emit PasskeyBound(msg.sender, x, y);
    }

    /// True when `account`'s bound passkey signed `challenge` in this assertion.
    function verifySession(
        address account,
        bytes32 challenge,
        bytes calldata authenticatorData,
        string calldata clientDataJSON,
        bytes32 r,
        bytes32 s
    ) external view returns (bool) {
        Key memory k = passkeyOf[account];
        if (k.x == bytes32(0)) revert NoPasskey();
        return _assertion(challenge, k.x, k.y, authenticatorData, clientDataJSON, r, s);
    }

    /// WebAuthn: the signature is over `sha256(authenticatorData ‖ sha256(clientDataJSON))`.
    function _assertion(
        bytes32 challenge,
        bytes32 x,
        bytes32 y,
        bytes calldata authenticatorData,
        string calldata clientDataJSON,
        bytes32 r,
        bytes32 s
    ) internal view returns (bool) {
        // flags byte, bit 0: the user was present
        if (authenticatorData.length < 37 || uint8(authenticatorData[32]) & 0x01 == 0) revert NotUserPresent();
        bytes memory json = bytes(clientDataJSON);
        if (!_contains(json, bytes('"type":"webauthn.get"'))) revert WrongCeremony();
        bytes memory want = abi.encodePacked('"challenge":"', Base64.encodeURL(abi.encodePacked(challenge)), '"');
        if (!_contains(json, want)) revert WrongChallenge();
        bytes32 h = sha256(abi.encodePacked(authenticatorData, sha256(json)));
        return P256.verifyNative(h, r, s, x, y);
    }

    function _contains(bytes memory hay, bytes memory needle) private pure returns (bool) {
        if (needle.length > hay.length) return false;
        for (uint256 i; i <= hay.length - needle.length; ++i) {
            bool ok = true;
            for (uint256 j; j < needle.length; ++j) {
                if (hay[i + j] != needle[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }
}
