// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

contract TestTarget {
    uint256 public value;

    function setValue(uint256 nextValue) external payable returns (uint256) {
        value = nextValue;
        return nextValue;
    }

    function forbidden() external {
        value = type(uint256).max;
    }
}