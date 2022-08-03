pragma solidity 0.7.5;

import "./OwnableDelegateProxy.sol";

interface ProxyRegistryInterface {
    function delegateProxyImplementation() external returns (address);

    function proxies(address owner) external returns (OwnableDelegateProxy);
}
