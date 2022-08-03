pragma solidity 0.7.5;

import "./lib/ExtMath.sol";

contract TestExtMath {
    using ExtMath for uint256;

    constructor() public {}

    function log2(uint256 x) public view returns (uint256 y) {
        return ExtMath.log2(x);
    }
}
