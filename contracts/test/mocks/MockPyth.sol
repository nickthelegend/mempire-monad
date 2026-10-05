// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPyth} from "../../src/interfaces/IPyth.sol";

/// A Pyth stand-in: an update is abi.encode(feedId, price, expo), and each one
/// costs `feePerUpdate` wei, like the real contract's per-update fee.
contract MockPyth is IPyth {
    uint256 public feePerUpdate = 1;
    mapping(bytes32 => Price) public prices;

    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256) {
        return updateData.length * feePerUpdate;
    }

    function updatePriceFeeds(bytes[] calldata updateData) external payable {
        require(msg.value == updateData.length * feePerUpdate, "fee");
        for (uint256 i; i < updateData.length; ++i) {
            (bytes32 id, int64 price, int32 expo) = abi.decode(updateData[i], (bytes32, int64, int32));
            prices[id] = Price({price: price, conf: 0, expo: expo, publishTime: block.timestamp});
        }
    }

    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (Price memory p) {
        p = prices[id];
        require(p.publishTime != 0, "PriceFeedNotFound");
        require(block.timestamp - p.publishTime <= age, "StalePrice");
    }
}
