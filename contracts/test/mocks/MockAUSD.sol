// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// Stands in for Agora's AUSD in tests: 6 decimals, ERC-2612 permit.
contract MockAUSD is ERC20, ERC20Permit {
    constructor() ERC20("AUSD", "AUSD") ERC20Permit("AUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
