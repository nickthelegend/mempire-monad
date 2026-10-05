// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {MarketMeta} from "../src/MarketMeta.sol";
import {IReceiver} from "../src/interfaces/IReceiver.sol";

contract MarketMetaTest is Base {
    function _report(uint64 epoch, int16 b0, int16 b1) internal pure returns (bytes memory) {
        uint16[] memory ids = new uint16[](2);
        ids[0] = 0;
        ids[1] = 5;
        int16[] memory bps = new int16[](2);
        bps[0] = b0;
        bps[1] = b1;
        return abi.encode(epoch, ids, bps);
    }

    function test_onReport_storesModifiers() public {
        vm.prank(forwarder);
        meta.onReport("", _report(1, 800, -1200));
        assertEq(meta.currentEpoch(), 1);
        assertEq(meta.modifierBps(1, 0), 800);
        assertEq(meta.modifierBps(1, 5), -1200);
        uint16[] memory q = new uint16[](3);
        q[0] = 5;
        q[1] = 0;
        q[2] = 9;
        int16[] memory out = meta.modifiersFor(1, q);
        assertEq(out[0], -1200);
        assertEq(out[1], 800);
        assertEq(out[2], 0);
    }

    function test_onlyForwarder() public {
        vm.expectRevert(MarketMeta.NotForwarder.selector);
        meta.onReport("", _report(1, 0, 0));
    }

    function test_rejectsStaleEpoch_andOutOfBounds() public {
        vm.startPrank(forwarder);
        meta.onReport("", _report(5, 0, 0));
        vm.expectRevert(MarketMeta.StaleEpoch.selector);
        meta.onReport("", _report(5, 0, 0));
        vm.expectRevert(MarketMeta.OutOfBounds.selector);
        meta.onReport("", _report(6, 1501, 0));
        vm.expectRevert(MarketMeta.OutOfBounds.selector);
        meta.onReport("", _report(6, 0, -1501));
        vm.stopPrank();
    }

    function test_workflowOwnerCheck() public {
        address owner = makeAddr("wfOwner");
        vm.prank(admin);
        meta.setExpectedWorkflowOwner(owner);
        bytes memory good = abi.encodePacked(bytes32("wf"), bytes10("mempire"), owner);
        bytes memory bad = abi.encodePacked(bytes32("wf"), bytes10("mempire"), makeAddr("other"));
        vm.startPrank(forwarder);
        vm.expectRevert(MarketMeta.WrongWorkflowOwner.selector);
        meta.onReport(bad, _report(1, 0, 0));
        meta.onReport(good, _report(1, 100, 100));
        vm.stopPrank();
        assertEq(meta.currentEpoch(), 1);
    }

    function test_supportsIReceiver() public view {
        assertTrue(meta.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(meta.supportsInterface(0x01ffc9a7));
        assertFalse(meta.supportsInterface(0xffffffff));
    }
}
