pragma solidity 0.7.5;

import "openzeppelin-solidity/contracts/token/ERC20/ERC20.sol";

contract MockFr0ntierToken is ERC20("Mock Fr0ntier Token", "Test") {
    constructor() public {}

    function mine(address to, uint256 value) public returns (bool) {
        _mint(to, value);
        return true;
    }
}
