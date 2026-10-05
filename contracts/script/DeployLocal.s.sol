// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Deploy} from "./Deploy.s.sol";
import {MockPyth} from "../src/mocks/MockPyth.sol";
import {MockAUSD, MockAUSDFaucet} from "../src/mocks/MockAUSD.sol";

/// The whole game on a local anvil: mock Pyth (with EMA), mock AUSD with permit,
/// a mock of Agora's `requestFunds` faucet, then exactly the testnet deploy.
///
///   anvil --port 8611 --prune-history 300
///   forge script script/DeployLocal.s.sol --rpc-url local --broadcast
///
/// Uses anvil's well-known dev accounts: #0 deploys and owns, #1 is the relayer,
/// #2 stands in for the CRE forwarder. Never use these keys anywhere real.
contract DeployLocal is Deploy {

    function run() external override {
        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", _anvil0());
        vm.startBroadcast(pk);
        MockPyth pyth = new MockPyth();
        MockAUSD ausd = new MockAUSD();
        MockAUSDFaucet faucet = new MockAUSDFaucet(ausd);
        vm.stopBroadcast();

        Env memory e;
        e.pk = pk;
        e.deployer = vm.addr(pk);
        e.relayer = vm.envOr("RELAYER", address(0x70997970C51812dc3A010C7d01b50e0d17dc79C8));
        e.pyth = address(pyth);
        e.ausd = address(ausd);
        e.ausdFaucet = address(faucet);
        e.forwarder = vm.envOr("CRE_FORWARDER", address(0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC));
        e.baseUri = vm.envOr("METADATA_BASE_URI", string("http://localhost:8799/nft/"));
        e.timeScale = uint32(vm.envOr("TIME_SCALE", uint256(60)));
        _run(e);
    }

    /// Anvil account #0, derived rather than pasted, from anvil's public test mnemonic.
    function _anvil0() internal view returns (uint256) {
        return vm.deriveKey("test test test test test test test test test test test junk", 0);
    }
}
