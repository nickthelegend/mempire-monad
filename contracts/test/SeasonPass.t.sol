// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MempireCards} from "../src/MempireCards.sol";
import {SeasonPass, IArenaWins} from "../src/SeasonPass.sol";

contract SeasonPassTest is Base {
    SeasonPass pass;
    uint256 season;
    uint128 constant PRICE = 200 ether;
    uint256[] aDeck;
    uint256[] bDeck;

    function setUp() public override {
        super.setUp();
        pass = new SeasonPass(admin, IERC20(address(token)), IArenaWins(address(arena)), cards, treasury);
        vm.startPrank(admin);
        cards.setSeasonPass(address(pass));
        uint16[] memory tiers = new uint16[](3);
        tiers[0] = 1; tiers[1] = 2; tiers[2] = 4;
        season = pass.startSeason(uint64(block.timestamp), uint64(block.timestamp + 14 days), PRICE, tiers);
        vm.stopPrank();
        aDeck = giveStarter(alice);
        bDeck = giveStarter(bob);
    }

    /// A MON match Alice wins (both session keys claim seat 0 → settled).
    function aliceWins() internal {
        uint128 stake = arena.stakeFor(address(0), 0);
        vm.prank(alice);
        uint64 id = arena.createMatch{value: stake + 0.05 ether}(0, address(0), aDeck, aliceSession, noPermit());
        vm.prank(bob);
        arena.joinMatch{value: stake + 0.05 ether}(id, bDeck, bobSession, noPermit());
        vm.prank(aliceSession);
        arena.claim(id, 0, keccak256("final"));
        vm.prank(bobSession);
        arena.claim(id, 0, keccak256("final"));
    }

    function buy(address who) internal {
        vm.startPrank(who);
        token.approve(address(pass), PRICE);
        pass.buyPass(season);
        vm.stopPrank();
    }

    function test_theArenaCountsStakedWins() public {
        aliceWins();
        aliceWins();
        assertEq(arena.wins(alice), 2);
        assertEq(arena.wins(bob), 0);
    }

    function test_buyingSendsThePriceToTheTreasury() public {
        uint256 before = token.balanceOf(treasury);
        buy(alice);
        assertEq(token.balanceOf(treasury) - before, PRICE);
        vm.prank(alice);
        vm.expectRevert(SeasonPass.AlreadyHasPass.selector);
        pass.buyPass(season);
    }

    function test_onlyWinsAfterBuyingCount() public {
        aliceWins();
        buy(alice);
        assertEq(pass.progress(season, alice), 0);
        aliceWins();
        assertEq(pass.progress(season, alice), 1);
    }

    function test_tiersUnlockByWinsAndClaimAGoldenChestOnce() public {
        buy(alice);
        vm.prank(alice);
        vm.expectRevert(SeasonPass.TierLocked.selector);
        pass.claim(season, 0);

        aliceWins();
        (uint256[] memory before,) = cards.chestsOf(alice);
        vm.prank(alice);
        uint256 chestId = pass.claim(season, 0);
        (uint256[] memory afterIds,) = cards.chestsOf(alice);
        assertEq(afterIds.length, before.length + 1);
        assertEq(afterIds[0], chestId); // newest first

        vm.prank(alice);
        vm.expectRevert(SeasonPass.AlreadyClaimed.selector);
        pass.claim(season, 0);
        vm.prank(alice);
        vm.expectRevert(SeasonPass.TierLocked.selector);
        pass.claim(season, 1);

        aliceWins();
        vm.prank(alice);
        pass.claim(season, 1);
        vm.prank(alice);
        vm.expectRevert(SeasonPass.NoSuchTier.selector);
        pass.claim(season, 3);
    }

    function test_noPassNoClaim() public {
        aliceWins();
        vm.prank(alice);
        vm.expectRevert(SeasonPass.NoPass.selector);
        pass.claim(season, 0);
    }

    function test_theSeasonCloses() public {
        buy(alice);
        aliceWins();
        vm.warp(block.timestamp + 15 days);
        vm.prank(alice);
        vm.expectRevert(SeasonPass.SeasonNotOpen.selector);
        pass.claim(season, 0);
        vm.startPrank(bob);
        token.approve(address(pass), PRICE);
        vm.expectRevert(SeasonPass.SeasonNotOpen.selector);
        pass.buyPass(season);
        vm.stopPrank();
    }

    function test_onlyThePassMintsChests() public {
        vm.prank(alice);
        vm.expectRevert(MempireCards.NotSeasonPass.selector);
        cards.grantGolden(alice);
    }

    function test_seasonsMustBeWellFormed() public {
        uint16[] memory bad = new uint16[](2);
        bad[0] = 3; bad[1] = 2;
        vm.prank(admin);
        vm.expectRevert(SeasonPass.BadSeason.selector);
        pass.startSeason(uint64(block.timestamp), uint64(block.timestamp + 1 days), PRICE, bad);
        vm.prank(alice);
        vm.expectRevert();
        pass.startSeason(uint64(block.timestamp), uint64(block.timestamp + 1 days), PRICE, bad);
    }
}
